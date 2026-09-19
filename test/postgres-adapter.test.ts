// src/adapters/postgres.ts over an injected docker seam (contract 00 section 14). No container
// runs here: `LocalPostgres` takes its `docker` the way `Scheduler` takes a `Runtime`, so the
// ORDER of the calls a fork makes, the readiness predicate and the replication line are all
// assertable in milliseconds. The Docker suites (fork.int, clone-isolation.int) prove the same
// paths against a real server; this file is what fails fast when the sequence changes.
import { test, expect, vi } from 'vitest'

// `forkMethod` reads the BOOT PROBE through `probedCapabilities()`, a process-wide singleton no
// unit test should have to run for real (it spawns `fsclone.cjs` against a real filesystem, and
// its answer differs between an APFS laptop and an ext4 runner). Pinning it to "this data dir can
// reflink" is what lets `INSTA_OSS_FORK=auto` be tested here at all: without it every `auto` fork
// resolves to the stream and the choice this file is about never happens.
vi.mock('../src/datadir', async (orig) => ({
  ...(await orig<typeof import('../src/datadir')>()),
  probedCapabilities: () => ({ dataDir: '/tmp/fake', reflink: true, engine: 'inprocess' as const }),
}))

import { LocalPostgres, pgWaitReady, type DockerExec } from '../src/adapters/postgres'
import type { Config } from '../src/config'
import { NoReflinkError, type DataDirOps, type PgTarget } from '../src/types'
import { testConfig } from './fakes'

const HBA = 'insta-oss basebackup'

/** A docker stub that records every argv. Containers in `running` answer `docker inspect` with
 *  their status, those in `stopped` answer `exited` (a database asleep, which is what a branch's
 *  parent normally is), and every other name is absent (which is what a destination looks like
 *  before a fork); `selectOne` answers the readiness statement; `on` overrides any single call. */
function stubDocker(opts: { running?: string[]; stopped?: string[]; status?: string; selectOne?: string; on?: (args: string[]) => string | Error | undefined } = {}): { calls: string[][]; exec: DockerExec } {
  const calls: string[][] = []
  const live = new Set(opts.running ?? [])
  const down = new Set(opts.stopped ?? [])
  const exec: DockerExec = async (args) => {
    calls.push([...args])
    const custom = opts.on?.(args)
    if (custom instanceof Error) throw custom
    if (typeof custom === 'string') return Buffer.from(custom)
    if (args[0] === 'inspect') {
      const name = args[args.length - 1]
      if (down.has(name)) return Buffer.from('exited\n')
      if (!live.has(name)) throw new Error('Error: No such object')
      return Buffer.from(`${opts.status ?? 'running'}\n`)
    }
    if (args.includes('select 1')) return Buffer.from(`${opts.selectOne ?? '1'}\n`)
    return Buffer.from('')
  }
  return { calls, exec }
}

/** A DataDirOps that records what the adapter asked of the filesystem. */
function stubData(over: Partial<DataDirOps> = {}): { ops: string[]; data: DataDirOps } {
  const ops: string[] = []
  const data: DataDirOps = {
    probe: async () => ({ dataDir: '/tmp/fake', reflink: true, engine: 'inprocess' }),
    ensureDir: async (path) => { ops.push(`ensureDir:${path}`) },
    clonePostgres: async (src, dst) => { ops.push(`clone:${src}->${dst}`); return { method: 'reflink', ms: 1 } },
    cloneTree: async (src, dst) => { ops.push(`cloneTree:${src}->${dst}`); return { method: 'reflink', ms: 1 } },
    remove: async (path) => { ops.push(`remove:${path}`) },
    rename: async (src, dst) => { ops.push(`rename:${src}->${dst}`) },
    copyFromContainerVolume: async () => { ops.push('copyFromVolume') },
    hasPgData: async () => true,
    isEmptyOrMissing: async () => true,
    ...over,
  }
  return { ops, data }
}

const cfgWith = (fork?: string): Config => testConfig(fork ? { INSTA_OSS_FORK: fork } : {})

const src = (over: Partial<PgTarget> = {}): PgTarget & { url: string } => ({
  container: 'io-demo-main-pg-db', network: 'io-demo-main', dataDir: '/data/pg/demo-main-db',
  url: 'postgres://postgres:sourcepw@io-demo-main-pg-db:5432/app', ...over,
})
const dst = (over: Partial<PgTarget> = {}): PgTarget => ({
  container: 'io-demo-feat-pg-db', network: 'io-demo-feat', dataDir: '/data/pg/demo-feat-db', ...over,
})

/** The argv of the calls, joined, so a test can talk about order without matching every flag. */
const line = (calls: string[][]): string[] => calls.map((a) => a.join(' '))
const indexOfMatch = (calls: string[][], needle: string): number => line(calls).findIndex((l) => l.includes(needle))

// ---- the replication line (host replication all all scram-sha-256) ------------------------------

test('query({sqlOnly}) refuses psql meta-commands at the transport, before any exec', async () => {
  const { calls, exec } = stubDocker({ running: ['c1'] })
  const { data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith(), data, docker: exec })

  // The bots' bypass was calling the adapter directly; the transport now refuses regardless of
  // caller, and nothing is exec'd. A backslash inside a literal is data and runs.
  for (const bad of ['select 1 \\! id', 'select 1 \\g select 2', 'select 1 \\gexec', 'select 1 \\watch 1']) {
    calls.length = 0
    await expect(pg.query('c1', bad, { sqlOnly: true })).rejects.toThrow(/meta-commands/)
    expect(calls).toEqual([])
  }
  // Without sqlOnly (trusted management SQL) the flag does not apply; with it, a literal backslash is fine.
  await expect(pg.query('c1', "select 'a\\b' as v", { sqlOnly: true })).resolves.toBeDefined()
})

test('a plain provision never writes the replication line into pg_hba.conf', async () => {
  const { calls, exec } = stubDocker()
  const { data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith(), data, docker: exec })

  const { url } = await pg.provision({ container: 'io-demo-main-pg-db', network: 'io-demo-main', dataDir: '/data/pg/demo-main-db' })

  expect(url).toMatch(/^postgres:\/\/postgres:[^@]+@io-demo-main-pg-db:5432\/app$/)
  // The database is created and readied.
  expect(indexOfMatch(calls, 'run -d --restart unless-stopped')).toBeGreaterThanOrEqual(0)
  expect(indexOfMatch(calls, 'pg_isready')).toBeGreaterThanOrEqual(0)
  // And it is NOT told to accept replication connections. Every branch database used to get this
  // line, on a lane that server mode publishes on all interfaces, for a stream it will never serve.
  expect(line(calls).filter((l) => l.includes(HBA))).toEqual([])
  expect(line(calls).filter((l) => l.includes('pg_reload_conf'))).toEqual([])
})

test('a basebackup fork appends the replication line to the SOURCE only, before it streams', async () => {
  const { calls, exec } = stubDocker({ running: ['io-demo-main-pg-db'] })
  const { data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith('basebackup'), data, docker: exec })

  const out = await pg.fork(src(), dst())
  expect(out.method).toBe('basebackup')

  // The append and the strip both name the marker, so tell them apart by shape.
  const appends = calls.filter((a) => a.join(' ').includes(HBA) && a.join(' ').includes('grep -q'))
  expect(appends).toHaveLength(1)
  // On the source container, and idempotent: the shell line greps before it appends.
  expect(appends[0]).toContain('io-demo-main-pg-db')
  expect(appends[0].join(' ')).toContain("grep -q 'insta-oss basebackup'")
  expect(appends[0].join(' ')).not.toContain('io-demo-feat-pg-db')
  // Before the stream, and the config is reloaded so the running server picks it up.
  expect(indexOfMatch(calls, HBA)).toBeLessThan(indexOfMatch(calls, 'pg_basebackup'))
  expect(indexOfMatch(calls, 'pg_reload_conf')).toBeLessThan(indexOfMatch(calls, 'pg_basebackup'))

  // A base backup copies pg_hba.conf, so the child would otherwise inherit the line and pass it on
  // again. It is stripped from the copy after the stream and BEFORE the child is ever started, so a
  // branch that is never a source accepts no replication connection.
  const strips = calls.filter((a) => a.join(' ').includes('sed -i') && a.join(' ').includes(HBA))
  expect(strips).toHaveLength(1)
  expect(strips[0].join(' ')).toContain('/out/pg_hba.conf')
  expect(indexOfMatch(calls, 'pg_basebackup')).toBeLessThan(indexOfMatch(calls, 'sed -i'))
})

test('a reflink fork writes no replication line at all: nothing streams', async () => {
  const { calls, exec } = stubDocker({ stopped: ['io-demo-main-pg-db'] })
  const { data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith('reflink'), data, docker: exec })

  const out = await pg.fork(src(), dst())
  expect(out.method).toBe('reflink')
  expect(line(calls).filter((l) => l.includes(HBA))).toEqual([])
  expect(indexOfMatch(calls, 'pg_basebackup')).toBe(-1)
})

// ---- destroy: the layer where the evidence was being destroyed ---------------------------------
//
// The adapters are where a failed removal used to become an already-absent one, and every
// teardown above them deletes bind-mounted data and drops the row that names it once destroy
// returns. Nothing bound this layer, which is the vacuous-coverage shape this review has hit
// twice already, so each of the three answers is pinned here and in test/manageddb-destroy.

test('destroy: a container docker says is not there is gone, quietly', async () => {
  const { calls, exec } = stubDocker({
    on: (args) => (args[0] === 'rm' ? new Error('Error: No such object: io-demo-feat-pg-db') : undefined),
  })
  const { data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith(), data, docker: exec })

  await expect(pg.destroy('io-demo-feat-pg-db')).resolves.toBeUndefined()
  // Dockerd answered, so no probe was needed.
  expect(calls.filter((a) => a[0] === 'inspect')).toEqual([])
})

test('destroy: an ambiguous failure is cleared by the probe when the container is really gone', async () => {
  const { calls, exec } = stubDocker({
    on: (args) => (args[0] === 'rm' ? new Error('Error response from daemon: conflict, in progress') : undefined),
  })
  const { data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith(), data, docker: exec })

  // The stub answers `inspect` for no container, i.e. `No such object`, so absence is confirmed.
  await expect(pg.destroy('io-demo-feat-pg-db')).resolves.toBeUndefined()
  expect(calls.filter((a) => a[0] === 'inspect')).toHaveLength(1)
})

test('destroy: a removal that failed with the container STILL THERE raises', async () => {
  const { exec } = stubDocker({
    running: ['io-demo-feat-pg-db'],
    on: (args) => (args[0] === 'rm' ? new Error('Error response from daemon: container is in use') : undefined),
  })
  const { data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith(), data, docker: exec })

  await expect(pg.destroy('io-demo-feat-pg-db')).rejects.toThrow(/container is in use/)
})

test('destroy: a probe that cannot answer is not absence either', async () => {
  const { exec } = stubDocker({
    on: (args) => new Error(args[0] === 'rm'
      ? 'Error response from daemon: conflict, in progress'
      : 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock'),
  })
  const { data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith(), data, docker: exec })

  await expect(pg.destroy('io-demo-feat-pg-db')).rejects.toThrow(/conflict, in progress/)
})

// ---- readiness (#34): the probe that must not answer early -------------------------------------// ---- readiness (#34): the probe that must not answer early -------------------------------------

test('readiness needs the row a live server sends: an empty answer is not ready', async () => {
  // The image's initdb phase runs a temporary server on the unix socket, so `select 1` over
  // 127.0.0.1 can come back with nothing while the real server is still starting. That is the bug
  // this probe exists for, and it stays not-ready until a `1` arrives.
  let answers = 0
  const { calls, exec } = stubDocker({
    running: ['io-demo-main-pg-db'],
    on: (args) => (args.includes('select 1') ? (answers++ < 2 ? '' : '1') : undefined),
  })
  await pgWaitReady('io-demo-main-pg-db', 10_000, exec)
  expect(answers).toBe(3)
  // Each not-ready round re-checks that the container is still alive before it sleeps.
  expect(calls.filter((a) => a[0] === 'inspect').length).toBe(2)
})

test('readiness gives up on the deadline with the last answer, and never calls it ready', async () => {
  const { exec } = stubDocker({ running: ['io-demo-main-pg-db'], selectOne: '' })
  await expect(pgWaitReady('io-demo-main-pg-db', 1, exec)).rejects.toThrow(/never became ready: select 1 answered ""/)
})

test('a container that exited during the wait ends it with its own logs', async () => {
  const { exec } = stubDocker({
    running: ['io-demo-main-pg-db'],
    status: 'exited',
    on: (args) => {
      if (args.includes('select 1')) return new Error('server closed the connection unexpectedly')
      if (args[0] === 'logs') return 'FATAL: data directory has invalid permissions'
      return undefined
    },
  })
  await expect(pgWaitReady('io-demo-main-pg-db', 10_000, exec))
    .rejects.toThrow(/exited before it became ready[\s\S]*invalid permissions/)
})

test('a plain provision waits for readiness before it hands back a DSN', async () => {
  const { calls, exec } = stubDocker()
  const { data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith(), data, docker: exec })
  await pg.provision({ container: 'io-demo-main-pg-db', network: 'io-demo-main', dataDir: '/data/pg/demo-main-db' })
  expect(indexOfMatch(calls, 'run -d')).toBeLessThan(indexOfMatch(calls, 'pg_isready'))
  expect(indexOfMatch(calls, 'pg_isready')).toBeLessThan(indexOfMatch(calls, 'select 1'))
})

test('a source that already carries the line is not asked twice in one fork', async () => {
  const { calls, exec } = stubDocker({ running: ['io-demo-main-pg-db'] })
  const { data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith('basebackup'), data, docker: exec })
  await pg.fork(src(), dst())
  await pg.fork(src(), dst({ container: 'io-demo-two-pg-db', dataDir: '/data/pg/demo-two-db' }))
  // Once per fork, always against the source, never against a destination.
  const appends = calls.filter((a) => a.join(' ').includes(HBA) && a.join(' ').includes('grep -q'))
  expect(appends).toHaveLength(2)
  for (const a of appends) expect(a).toContain('io-demo-main-pg-db')
  // And each destination is stripped, so neither child can become a source by inheritance.
  const strips = calls.filter((a) => a.join(' ').includes('sed -i') && a.join(' ').includes(HBA))
  expect(strips).toHaveLength(2)
})

// ---- fork ordering -----------------------------------------------------------------------------

test('a reflink fork clones a source at rest, then starts the copy and waits for it', async () => {
  // The source is STOPPED, which is what a branch's parent normally is here: databases sleep, and
  // a stopped data directory is the one a file-level clone can copy safely. The fixture used to
  // run this against a live source and assert a CHECKPOINT before the walk; a CHECKPOINT freezes
  // nothing, so that arrangement is not one this adapter may clone at all any more.
  const { calls, exec } = stubDocker({ stopped: ['io-demo-main-pg-db'] })
  const { ops, data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith('reflink'), data, docker: exec })

  const out = await pg.fork(src(), dst())
  expect(out.method).toBe('reflink')
  expect(ops).toEqual(['clone:/data/pg/demo-main-db->/data/pg/demo-feat-db'])
  // Nothing is asked of the source: it has no writer to flush, and a query would have to start it.
  expect(indexOfMatch(calls, 'CHECKPOINT')).toBe(-1)
  // The destination container starts on the copy and crash recovery is waited out.
  const started = indexOfMatch(calls, 'run -d --restart unless-stopped --name io-demo-feat-pg-db')
  const ready = line(calls).findIndex((l) => l.includes('pg_isready') && l.includes('io-demo-feat-pg-db'))
  expect(started).toBeGreaterThanOrEqual(0)
  expect(ready).toBeGreaterThan(started)
  expect(indexOfMatch(calls, 'pg_basebackup')).toBe(-1)
})

// ---- the source has to be at rest (a live PGDATA cannot be copied file by file) ----------------

test('a fork of a RUNNING source streams instead of walking its data directory', async () => {
  // `auto` on a box whose probe says it can reflink. The source is live, so the walk would assemble
  // the destination out of several moments of a data directory that is still being written:
  // concurrent writes, the server's own checkpoints, files created and unlinked, WAL recycled.
  // That is a torn copy, and it is decided here, before anything is created.
  const { calls, exec } = stubDocker({ running: ['io-demo-main-pg-db'] })
  const { ops, data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith(), data, docker: exec })

  const out = await pg.fork(src(), dst())
  expect(out.method).toBe('basebackup')
  expect(ops.filter((o) => o.startsWith('clone:'))).toEqual([])
  expect(indexOfMatch(calls, 'pg_basebackup')).toBeGreaterThanOrEqual(0)
  // ...and the destination lost nothing to the decision: this fixture has no interrupted attempt
  // sitting there (`isEmptyOrMissing` is true and the container does not exist), so the orphan
  // sweep that now runs first finds nothing to remove.
  expect(ops.filter((o) => o.startsWith('remove:'))).toEqual([])
})

test('INSTA_OSS_FORK=reflink refuses a running source instead of making a torn copy', async () => {
  const { calls, exec } = stubDocker({ running: ['io-demo-main-pg-db'] })
  const { ops, data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith('reflink'), data, docker: exec })

  // The strict setting means "fail rather than stream"; it is not a licence to copy a live server.
  await expect(pg.fork(src(), dst())).rejects.toThrow(/is running: a file-level clone/)
  await expect(pg.fork(src(), dst())).rejects.toThrow(/refusing to fall back to pg_basebackup/)
  expect(ops.filter((o) => o.startsWith('clone:'))).toEqual([])
  expect(indexOfMatch(calls, 'pg_basebackup')).toBe(-1)
})

test('a source that starts DURING the walk throws the copy away and streams', async () => {
  // Nothing in this daemon can start the source while a fork holds its ServiceKey (decision 52),
  // but a `docker start` from outside is under no lock of ours, so the walk is re-checked after it.
  const live = new Set<string>()
  const calls: string[][] = []
  const exec: DockerExec = async (args) => {
    calls.push([...args])
    if (args[0] === 'inspect') {
      const name = args[args.length - 1]
      if (name === 'io-demo-main-pg-db') return Buffer.from(live.has(name) ? 'running\n' : 'exited\n')
      throw new Error('Error: No such object')
    }
    if (args.includes('select 1')) return Buffer.from('1\n')
    return Buffer.from('')
  }
  const { ops, data } = stubData({
    clonePostgres: async (s, d) => { ops.push(`clone:${s}->${d}`); live.add('io-demo-main-pg-db'); return { method: 'reflink', ms: 1 } },
  })
  const pg = new LocalPostgres({ cfg: cfgWith(), data, docker: exec })

  const out = await pg.fork(src(), dst())
  expect(out.method).toBe('basebackup')
  // The clone happened and was then discarded, rather than being started and trusted.
  expect(ops).toContain('clone:/data/pg/demo-main-db->/data/pg/demo-feat-db')
  expect(ops).toContain('remove:/data/pg/demo-feat-db')
  expect(calls.findIndex((a) => a.includes('pg_basebackup'))).toBeGreaterThanOrEqual(0)
  // The half-copy never became a container.
  const startedCopy = calls.findIndex((a) => a.join(' ').includes('--name io-demo-feat-pg-db'))
  expect(startedCopy).toBeGreaterThan(calls.findIndex((a) => a.includes('pg_basebackup')))
})

test('a source that starts AND STOPS again during the walk is caught, and the copy is thrown away', async () => {
  // The case above is only half of it. A `docker start` from outside that is still running when
  // the walk ends changes the STATUS, so a status re-read catches it; a start followed by a stop
  // does not. The container is `exited` before the walk and `exited` after it, while a postmaster
  // ran, recovered, checkpointed and shut down in between -- and the walk assembled the copy out
  // of both sides of that. What moves is the pair of run timestamps docker stamps, so the whole
  // fingerprint is what gets compared.
  const seen: string[] = []
  let run = 1
  // The source is at rest for both reads; the fork's own wake door is what makes it live, after
  // the walk has already been judged, because the stream it falls back to needs a running server.
  let live = false
  const status = (): string => (live ? 'running' : 'exited')
  // Both reads say `exited`. Only the timestamps differ, exactly as a real stop-start-stop leaves
  // them (measured: a start moves StartedAt, the stop that follows moves FinishedAt).
  const fingerprint = (): string => `${status()}|2026-09-10T07:13:1${run}.437235833Z|2026-09-10T07:13:1${run}.619748917Z`
  const calls: string[][] = []
  const exec: DockerExec = async (args) => {
    calls.push([...args])
    if (args[0] === 'inspect') {
      if (args[args.length - 1] !== 'io-demo-main-pg-db') throw new Error('Error: No such object')
      if (!args[2].includes('StartedAt')) return Buffer.from(`${status()}\n`)
      const fp = fingerprint()
      seen.push(fp)
      return Buffer.from(`${fp}\n`)
    }
    if (args.includes('select 1')) return Buffer.from('1\n')
    return Buffer.from('')
  }
  const { ops, data } = stubData({
    // One whole run of the source, begun and ended inside the walk.
    clonePostgres: async (s, d) => { ops.push(`clone:${s}->${d}`); run++; return { method: 'reflink', ms: 1 } },
  })
  const pg = new LocalPostgres({ cfg: cfgWith(), data, docker: exec })

  const out = await pg.fork(src(), dst(), { ensureSourceRunning: async () => { live = true } })

  // The copy that spans the run is discarded, not started and trusted.
  expect(out.method).toBe('basebackup')
  expect(ops).toContain('clone:/data/pg/demo-main-db->/data/pg/demo-feat-db')
  expect(ops).toContain('remove:/data/pg/demo-feat-db')
  const streamed = calls.findIndex((a) => a.includes('pg_basebackup'))
  expect(streamed).toBeGreaterThanOrEqual(0)
  expect(calls.findIndex((a) => a.join(' ').includes('--name io-demo-feat-pg-db'))).toBeGreaterThan(streamed)
  // ...and the fixture is what makes that binding: the status is IDENTICAL on both reads, so
  // nothing but the timestamps could have caught this one.
  expect(seen).toHaveLength(2)
  expect(seen[0].split('|')[0]).toBe('exited')
  expect(seen[1].split('|')[0]).toBe('exited')
  expect(seen[0]).not.toBe(seen[1])
})

test('a PAUSED source is streamed too: an unpause and re-pause inside the walk moves no field', async () => {
  // A paused container is a live postmaster with its processes frozen, and `docker unpause`
  // followed by `docker pause` leaves the status, both run timestamps and even the pid exactly as
  // they were (measured on Docker 27). There is therefore no reading that can show a paused
  // source held still for the walk, so it is refused up front like a running one and streamed
  // instead. The stream then needs it live, and the engine's door is what unpauses it: the
  // scheduler's `api` door does exactly this before it starts anything.
  let state = 'paused'
  const calls: string[][] = []
  const exec: DockerExec = async (args) => {
    calls.push([...args])
    if (args[0] === 'inspect') {
      if (args[args.length - 1] !== 'io-demo-main-pg-db') throw new Error('Error: No such object')
      return Buffer.from(`${state}\n`)
    }
    if (args.includes('select 1')) return Buffer.from('1\n')
    return Buffer.from('')
  }
  const { ops, data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith(), data, docker: exec })

  const out = await pg.fork(src(), dst(), { ensureSourceRunning: async () => { state = 'running' } })

  expect(out.method).toBe('basebackup')
  expect(ops.filter((o) => o.startsWith('clone:'))).toEqual([])
  expect(indexOfMatch(calls, 'pg_basebackup')).toBeGreaterThanOrEqual(0)
})

test('a paused source with no door fails at once instead of polling a container that is frozen', async () => {
  // Without a door nothing unpauses it, and a frozen postmaster answers no probe and never
  // exits: `waitReady` would poll it for the whole two-minute readiness window and then blame
  // readiness. The state is known here, so it is said here.
  const { calls, exec } = stubDocker({ running: ['io-demo-main-pg-db'], status: 'paused' })
  const { data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith(), data, docker: exec })

  await expect(pg.fork(src(), dst())).rejects
    .toThrow(/needs the source running: io-demo-main-pg-db is paused and the caller passed no wake door/)
  // ...and it never entered the poll at all.
  expect(indexOfMatch(calls, 'pg_isready')).toBe(-1)
})

test('INSTA_OSS_FORK=reflink names the state it refused, paused included', async () => {
  const { exec } = stubDocker({ running: ['io-demo-main-pg-db'], status: 'paused' })
  const { data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith('reflink'), data, docker: exec })
  await expect(pg.fork(src(), dst())).rejects.toThrow(/is paused: a file-level clone/)
})

test('a sleeping source is cloned as it lies: no CHECKPOINT, and the copy still starts', async () => {
  // `running: []`: the source container exists for nobody, which is what an asleep (exited) or
  // already removed source looks like to `docker inspect -f {{.State.Status}}`.
  const { calls, exec } = stubDocker()
  const { ops, data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith('reflink'), data, docker: exec })

  const out = await pg.fork(src(), dst())
  expect(out.method).toBe('reflink')
  expect(indexOfMatch(calls, 'CHECKPOINT')).toBe(-1)
  expect(ops).toEqual(['clone:/data/pg/demo-main-db->/data/pg/demo-feat-db'])
})

test('an unreadable probe stops the fork instead of clearing or cloning into the destination', async () => {
  // `clearOrphan` removes a container AND recursively deletes a Postgres data directory. The
  // only evidence it has is docker's answer about that container, and `referenced` is absent on
  // every path where the caller believes it is creating the service. So a probe that could not
  // answer must stop the sweep before both, not after the container half.
  // The SOURCE is at rest and readable, so `auto` would take the reflink path; only the
  // DESTINATION's probe cannot answer.
  const { calls, exec } = stubDocker({
    stopped: ['io-demo-main-pg-db'],
    on: (args) => (args[0] === 'inspect' && args[args.length - 1] === 'io-demo-feat-pg-db'
      ? new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock')
      : undefined),
  })
  const { ops, data } = stubData({ isEmptyOrMissing: async () => false })
  const pg = new LocalPostgres({ cfg: cfgWith(), data, docker: exec })

  await expect(pg.fork(src(), dst())).rejects.toThrow(/cannot tell whether io-demo-feat-pg-db is an orphan/)

  // Nothing of the destination was touched on an unanswered question: not the container, not the
  // bytes, and not by a clone into it either.
  expect(ops.filter((o) => o.startsWith('remove:'))).toEqual([])
  expect(calls.filter((a) => a[0] === 'rm')).toEqual([])
  expect(ops.filter((o) => o.startsWith('clone:'))).toEqual([])
  // ...and the failure is NOT swallowed into "try the other copy method": a destination that
  // could not be cleared is not a reason to stream into it.
  expect(indexOfMatch(calls, 'pg_basebackup')).toBe(-1)
})

test('a probe that cannot answer is not evidence the source is at rest', async () => {
  // `docker inspect` failing says nothing about the container unless dockerd SAYS there is no
  // such container. A daemon that is not talking, a template error, a permission failure: read
  // any of those as absence and the fork walks a PGDATA that may have a live postmaster in it.
  // The explicit no-such-object answer still means "no writer" and still clones, which the
  // sleeping-source case above pins.
  const { ops, data } = stubData()
  // Only the SOURCE's probe fails: the destination answers, so this is about the source's state
  // and not about the orphan sweep (the case below).
  const { exec } = stubDocker({
    on: (args) => (args[0] === 'inspect' && args[args.length - 1] === 'io-demo-main-pg-db'
      ? new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock')
      : undefined),
  })
  const pg = new LocalPostgres({ cfg: cfgWith(), data, docker: exec })

  await expect(pg.fork(src(), dst())).rejects.toThrow(/could not report the state of io-demo-main-pg-db|needs the source running/)
  // The walk never happened.
  expect(ops.filter((o) => o.startsWith('clone:'))).toEqual([])
})

test('a clone that comes out unrecoverable is retried exactly once, cleaning up each time', async () => {
  // The source is at rest, so this is a copy the adapter is allowed to make and it still did not
  // recover: a source damaged before the fork (an interrupted earlier copy) is what is left once
  // the live-source case streams. `INSTA_OSS_FORK=reflink` is the operator asking to FAIL instead
  // of streaming, so the second unrecoverable copy surfaces as a refusal.
  const { calls, exec } = stubDocker({
    stopped: ['io-demo-main-pg-db'],
    on: (args) => {
      if (args[0] === 'exec' && args[1] === 'io-demo-feat-pg-db') return new Error('pg_isready: no response')
      if (args[0] === 'logs') return 'PANIC: could not locate a valid checkpoint record'
      return undefined
    },
  })
  const { ops, data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith('reflink'), data, docker: exec })

  await expect(pg.fork(src(), dst())).rejects.toThrow(/refusing to fall back to pg_basebackup/)
  // Two attempts, each with its half-written copy and its container taken away again.
  expect(ops.filter((o) => o.startsWith('clone:'))).toHaveLength(2)
  expect(ops.filter((o) => o === 'remove:/data/pg/demo-feat-db')).toHaveLength(2)
  // One torn-copy diagnosis read per attempt (the wait quotes its own shorter tail separately).
  expect(calls.filter((a) => a[0] === 'logs' && a[2] === '200' && a.includes('io-demo-feat-pg-db'))).toHaveLength(2)
  expect(calls.filter((a) => a[0] === 'rm' && a.includes('io-demo-feat-pg-db'))).toHaveLength(2)
  // And nothing streamed behind the operator's back.
  expect(indexOfMatch(calls, 'pg_basebackup')).toBe(-1)
})

test('an interrupted attempt is cleared even when the source turns out to be running', async () => {
  // The strict setting refuses a live source rather than streaming, and that refusal used to
  // return before the orphan sweep ran. What is left behind then is an earlier attempt's
  // destination -- a container of the right name, a half-written data directory -- that no live
  // branch row references and that no later step will clear either, because there is no stream
  // to clear it: it just sits there holding a name, a port and disk.
  const { calls, exec } = stubDocker({ running: ['io-demo-main-pg-db', 'io-demo-feat-pg-db'] })
  const { ops, data } = stubData({ isEmptyOrMissing: async () => false })
  const pg = new LocalPostgres({ cfg: cfgWith('reflink'), data, docker: exec })

  await expect(pg.fork(src(), dst())).rejects.toThrow(/is running: a file-level clone/)
  expect(calls.filter((a) => a[0] === 'rm' && a.includes('io-demo-feat-pg-db'))).toHaveLength(1)
  expect(ops).toContain('remove:/data/pg/demo-feat-db')
  // The source is not touched by any of it, refusal or not.
  expect(calls.filter((a) => a[0] === 'rm' && a.includes('io-demo-main-pg-db'))).toEqual([])
  expect(ops.filter((o) => o.includes('demo-main'))).toEqual([])

  // ...and a destination a live row still references is left alone, exactly as on the paths that
  // do not refuse: the `referenced` check survives the move.
  const second = stubDocker({ running: ['io-demo-main-pg-db', 'io-demo-feat-pg-db'] })
  const kept = stubData({ isEmptyOrMissing: async () => false })
  const pg2 = new LocalPostgres({ cfg: cfgWith('reflink'), data: kept.data, docker: second.exec })
  await expect(pg2.fork(src(), dst(), { referenced: () => true })).rejects.toThrow(/is running: a file-level clone/)
  expect(second.calls.filter((a) => a[0] === 'rm')).toEqual([])
  expect(kept.ops.filter((o) => o.startsWith('remove:'))).toEqual([])
})

test('INSTA_OSS_FORK=reflink on a filesystem that cannot clone fails instead of streaming', async () => {
  const { calls, exec } = stubDocker({ stopped: ['io-demo-main-pg-db'] })
  const { data } = stubData({ clonePostgres: async () => { throw new NoReflinkError('this filesystem cannot clone') } })
  const pg = new LocalPostgres({ cfg: cfgWith('reflink'), data, docker: exec })

  await expect(pg.fork(src(), dst())).rejects.toThrow(/refusing to fall back to pg_basebackup/)
  expect(indexOfMatch(calls, 'pg_basebackup')).toBe(-1)
})

test('a basebackup fork wakes the source first, and streams straight into the destination mount', async () => {
  const woken: string[] = []
  const { calls, exec } = stubDocker({ running: ['io-demo-main-pg-db'] })
  const { ops, data } = stubData()
  const pg = new LocalPostgres({ cfg: cfgWith('basebackup'), data, docker: exec })

  const out = await pg.fork(src(), dst(), { ensureSourceRunning: async () => { woken.push('src') } })
  expect(out.method).toBe('basebackup')
  // The stream needs a RUNNING source, so the engine's door is used before anything is read.
  expect(woken).toEqual(['src'])
  const stream = calls.find((a) => a.includes('pg_basebackup'))!
  expect(stream.join(' ')).toContain('--network io-demo-main')       // the SOURCE branch network
  expect(stream.join(' ')).toContain('-v /data/pg/demo-feat-db:/out') // no byte passes through us
  expect(stream.join(' ')).toContain('PGPASSWORD=sourcepw')
  expect(stream.join(' ')).toContain('-X stream --checkpoint=fast --no-password')
  // The destination directory exists before the stream and the copy is started afterwards.
  expect(ops).toContain('ensureDir:/data/pg/demo-feat-db')
  expect(indexOfMatch(calls, 'pg_basebackup')).toBeLessThan(indexOfMatch(calls, '--name io-demo-feat-pg-db'))
  // The clone inherits the source's roles, so the DSN is the source's with the host swapped.
  expect(out.url).toBe('postgres://postgres:sourcepw@io-demo-feat-pg-db:5432/app')
})

test('an interrupted earlier attempt is cleared, and anything a live row still references is not', async () => {
  const { calls, exec } = stubDocker({ stopped: ['io-demo-main-pg-db'], running: ['io-demo-feat-pg-db'] })
  const { ops, data } = stubData({ isEmptyOrMissing: async () => false })
  const pg = new LocalPostgres({ cfg: cfgWith('reflink'), data, docker: exec })

  await pg.fork(src(), dst())
  expect(calls.filter((a) => a[0] === 'rm' && a.includes('io-demo-feat-pg-db'))).toHaveLength(1)
  expect(ops[0]).toBe('remove:/data/pg/demo-feat-db')

  // A destination a live branch row still owns is never touched: the caller says so.
  const second = stubDocker({ stopped: ['io-demo-main-pg-db'], running: ['io-demo-feat-pg-db'] })
  const kept = stubData({ isEmptyOrMissing: async () => false })
  const pg2 = new LocalPostgres({ cfg: cfgWith('reflink'), data: kept.data, docker: second.exec })
  await pg2.fork(src(), dst(), { referenced: () => true })
  expect(second.calls.filter((a) => a[0] === 'rm')).toEqual([])
  expect(kept.ops.filter((o) => o.startsWith('remove:'))).toEqual([])
})
