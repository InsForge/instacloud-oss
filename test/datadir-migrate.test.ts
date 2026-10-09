// The boot migration's CRASH BOUNDARIES (04 section F, decision 24: "resumable").
//
// `test/datadir-migrate.int.test.ts` proves the migration works on real Docker. It cannot prove the
// interesting half: what a daemon killed halfway through leaves behind, and what the boot after it
// does with that. Every step of this migration ends by DELETING the source -- a legacy container
// and its anonymous volume, or a docker named volume -- so a step that reports "already finished"
// when it is not costs the only complete copy of a user's data.
//
// So this file drives `migrateLegacyData` against an in-memory docker and an in-memory data dir,
// kills it at each boundary, and boots again:
//
//   postgres  A. mid-copy            B. copied, not promoted   C. container up, state not written
//   volumes   D. mid-copy
//   managed   E. mid-copy            F. legacy container removed, replacement not created
//
// At every one of them two things have to hold: the SOURCE is still there, and the next boot
// finishes the job with the data whole.
import { test, expect, afterEach, beforeEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Only the SEAM is faked. `inspectField` and the two symbols beside it are the shipped
// classification (present | gone | unknown), and this file's whole point is which of those three
// the migration acts on, so a hand-written stand-in for it would be the test grading its own
// homework. The migration passes this `docker` into `inspectField` explicitly, so the real
// classifier runs against the fake daemon.
vi.mock('../src/docker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/docker')>()),
  docker: vi.fn(async (argv: string[]) => world.docker(argv)),
}))
vi.mock('../src/adapters/postgres', () => ({
  pgRun: vi.fn(async (t: { container: string; dataDir: string }) => world.run(t.container, [t.dataDir])),
  pgWaitReady: vi.fn(async () => undefined),
  pgAppendHba: vi.fn(async () => hooks.appendHba?.()),
}))

import { pgAppendHba } from '../src/adapters/postgres'
import { loadConfig } from '../src/config'
import { dataLayout } from '../src/datadir'
import { migrateLegacyData } from '../src/datadir-migrate'
import { initStatePath, loadState, mutate } from '../src/state'
import type { MigrateDeps } from '../src/datadir-migrate'
import type { DataDirOps } from '../src/types'

const REF = 'demo-main'
const LEGACY_PG = `io-${REF}-pg`
const NEW_PG = `io-${REF}-pg-db`
const APP = `io-${REF}-app-web`
const VOL_ID = 'v0lume01'
const LEGACY_VOL = `io-${REF}-data-${VOL_ID}`
const MD_REDIS = `io-${REF}-rd-cache`
const BRANCH2_ID = 'b2'
const REF2 = 'demo-feat'
const MD_REDIS_2 = `io-${REF2}-rd-cache`
const PROJECT_ID = 'p1'
const BRANCH_ID = 'b1'
const PG_PASSWORD = 'kept'

/** What a real PGDATA copy produces, in the order the walk reaches it: `PG_VERSION` is four bytes
 *  near the front, which is exactly why its presence cannot mean "the copy finished". */
const PGDATA_FILES = ['PG_VERSION', 'postgresql.conf', 'pg_hba.conf', 'global/pg_control', 'base/1/1259', 'base/5/2608', 'pg_wal/000000010000000000000001']
const VOL_FILES = ['keep.txt', 'nested/deep.bin']
const REDIS_FILES = ['dump.rdb', 'appendonly.aof']

/** How many entries this BOOT may copy before it is interrupted, counted across every copy it
 *  makes; `Infinity` lets it finish. `onRename` and `appendHba` kill it at the two boundaries a
 *  byte budget cannot reach. */
const hooks: {
  budget: number
  onRename?: () => void
  appendHba?: () => void
  /** A docker that cannot ANSWER, for the calls this predicate names. Not "no such container",
   *  which is an answer: a daemon that is not talking, and the whole point of the three-way
   *  classification is that the two are different evidence. */
  unreadable?: (argv: string[]) => boolean
} = { budget: Infinity }
let copied = 0

/** Something a kill -9 stands in for. Nothing catches it but the per-branch guard in
 *  `migrateLegacyData`, which is what a crash looks like from the next boot's point of view: no
 *  `dataVersion` stamp, and whatever the previous run got as far as still on disk. */
class Killed extends Error {}

// ---- in-memory docker + data dir ----

class World {
  containers = new Map<string, { running: boolean; mounts: string[] }>()
  volumes = new Set<string>()
  /** Files of a source the migration reads: keyed by container name or `volume:<name>`. */
  sources = new Map<string, string[]>()
  /** The data dir: every path that exists, files and directories alike. */
  paths = new Set<string>()
  log: string[] = []

  run(name: string, mounts: string[]): void {
    if (this.containers.has(name)) throw new Error(`container ${name} already exists`)
    this.log.push(`run:${name}`)
    this.containers.set(name, { running: true, mounts })
  }

  async docker(argv: string[]): Promise<Buffer> {
    const [verb] = argv
    if (hooks.unreadable?.(argv)) {
      throw new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')
    }
    if (verb === 'inspect') {
      const fmt = argv[2]
      const name = argv[3]
      const c = this.containers.get(name)
      if (!c) throw new Error(`No such object: ${name}`)
      if (fmt === '{{.Id}}') return Buffer.from(`id-${name}`)
      if (fmt === '{{.State.Running}}') return Buffer.from(String(c.running))
      if (fmt.includes('.Mounts')) return Buffer.from(`${c.mounts.join(' ')} `)
      throw new Error(`unmocked format ${fmt}`)
    }
    if (verb === 'stop') {
      const c = this.containers.get(argv[1])
      if (!c) throw new Error('No such container')
      this.log.push(`stop:${argv[1]}`)
      c.running = false
      return Buffer.from('')
    }
    if (verb === 'rm') {
      const name = argv[argv.length - 1]
      if (!this.containers.has(name)) throw new Error('No such container')
      this.log.push(`rm:${name}`)
      this.containers.delete(name)
      if (argv.includes('-v')) this.sources.delete(name)
      return Buffer.from('')
    }
    if (verb === 'volume') {
      const name = argv[2]
      if (argv[1] === 'inspect') {
        if (!this.volumes.has(name)) throw new Error('No such volume')
        return Buffer.from('[]')
      }
      if (argv[1] === 'rm') {
        if (!this.volumes.has(name)) throw new Error('No such volume')
        this.log.push(`volume rm:${name}`)
        this.volumes.delete(name)
        this.sources.delete(`volume:${name}`)
        return Buffer.from('')
      }
    }
    throw new Error(`unmocked docker ${argv.join(' ')}`)
  }

  // ---- the data dir ----

  under(dir: string): string[] {
    return [...this.paths].filter((p) => p.startsWith(`${dir}/`))
  }

  add(path: string): void {
    const parts = path.split('/')
    for (let i = 2; i <= parts.length; i++) this.paths.add(parts.slice(0, i).join('/'))
  }

  rm(path: string): void {
    for (const p of [...this.paths]) if (p === path || p.startsWith(`${path}/`)) this.paths.delete(p)
  }

  mv(src: string, dst: string): void {
    if (!this.paths.has(src)) throw new Error(`ENOENT: no such file or directory, rename '${src}'`)
    if (this.paths.has(dst)) throw new Error(`ENOTEMPTY: rename '${src}' -> '${dst}'`)
    for (const p of [...this.paths]) {
      if (p === src || p.startsWith(`${src}/`)) {
        this.paths.delete(p)
        this.add(dst + p.slice(src.length))
      }
    }
    this.log.push(`rename:${src}->${dst}`)
  }
}

let world: World
let cfg: ReturnType<typeof loadConfig>
let deps: MigrateDeps

function makeData(): DataDirOps {
  return {
    probe: async () => ({ dataDir: cfg.dataDir, reflink: true, engine: 'inprocess' }),
    ensureDir: async (path) => { world.add(path) },
    clonePostgres: async () => ({ method: 'reflink', ms: 1 }),
    cloneTree: async () => ({ method: 'reflink', ms: 1 }),
    remove: async (path) => { world.rm(path) },
    rename: async (src, dst) => { hooks.onRename?.(); world.mv(src, dst) },
    copyFromContainerVolume: async (source, containerPath, dst) => {
      const key = source.container ?? `volume:${source.volume}`
      const files = world.sources.get(key)
      if (!files) throw new Error(`nothing to copy from ${key}`)
      world.log.push(`copy:${key}${containerPath}->${dst}`)
      world.add(dst)
      for (const f of files) {
        if (copied >= hooks.budget) throw new Killed(`killed after ${copied} entries, inside ${key}`)
        world.add(`${dst}/${f}`)
        copied++
      }
    },
    hasPgData: async (dir) => world.paths.has(`${dir}/PG_VERSION`),
    isEmptyOrMissing: async (dir) => world.under(dir).length === 0,
  }
}

/** state.json exactly as a pre-scaffold daemon wrote it: `dbUrl` and no `databases`, no
 *  `dataVersion`, and no `dataId` on the managed registration -- which is the point of that
 *  field being absent here rather than set to a convenient constant. It carried
 *  `dataId: 'cache'` while the comment claimed there was none anywhere, and that is why a
 *  per-branch mint of the missing id survived: nothing in this file ever exercised the mint.
 *  `secondBranch` is what makes the id's PROJECT scope observable at all, and `managedDataId`
 *  models the one install that legitimately HAS one before this pass runs: a boot that was
 *  interrupted after the backfill persisted the id and before the copy finished. A test that
 *  seeds anything at a managed data path needs it, because the path is `<prefix>-<dataId>` and
 *  seeding before the id exists writes to a directory the migration will never look at. */
function writeLegacyState(opts: { managed?: boolean; secondBranch?: boolean; managedDataId?: string } = {}): void {
  writeFileSync(cfg.statePath, JSON.stringify({
    projects: {
      [PROJECT_ID]: {
        id: PROJECT_ID, name: 'demo', status: 'ready', createdAt: 1, refSlug: 'demo',
        computeGroups: ['web'], computeVolumes: { web: { id: VOL_ID, sizeGib: 1 } },
        ...(opts.managed ? { managedServices: [{ id: 'md-cache', type: 'redis', name: 'cache', ...(opts.managedDataId ? { dataId: opts.managedDataId } : {}) }] } : {}),
      },
    },
    branches: {
      [BRANCH_ID]: {
        id: BRANCH_ID, projectId: PROJECT_ID, name: 'main', isDefault: true, status: 'ready',
        ref: REF, network: `io-${REF}`, cloneOf: null, createdAt: 1,
        dbUrl: `postgres://postgres:${PG_PASSWORD}@${LEGACY_PG}:5432/app`,
        apps: { web: { image: 'nginx:alpine', port: 80, hostPort: 18201 } },
        ...(opts.managed ? { managed: { 'md-cache': { password: 'redis-pw' } } } : {}),
      },
      // A second branch of the same project: it carries the same managed service, on its own
      // ref, which is the only way the project-level `dataId` can be seen to be one id.
      ...(opts.secondBranch ? {
        [BRANCH2_ID]: {
          id: BRANCH2_ID, projectId: PROJECT_ID, name: 'feat', isDefault: false, status: 'ready',
          ref: REF2, network: `io-${REF2}`, cloneOf: BRANCH_ID, createdAt: 2,
          dbUrl: `postgres://postgres:${PG_PASSWORD}@io-${REF2}-pg:5432/app`,
          apps: {},
          ...(opts.managed ? { managed: { 'md-cache': { password: 'redis-pw' } } } : {}),
        },
      } : {}),
    },
    policies: {}, approvals: [], events: [], userSecrets: {},
    rev: 1, auditRev: 0, customDomains: {}, templateDeployments: {},
  }, null, 2), { mode: 0o600 })
}
/** Where a copy is staged: the sibling `copyIntoPlace` promotes from. */
const appContainer = (group: string): string => `io-${REF}-app-${group}`
/** Where a copy is staged: the sibling directory `copyIntoPlace` promotes from. */
const stagingOf = (target: string): string => {
  const cut = target.lastIndexOf('/')
  return `${target.slice(0, cut)}/.incoming-${target.slice(cut + 1)}`
}

const layout = (): ReturnType<typeof dataLayout> => dataLayout(cfg.dataDir)
const pgDir = (): string => layout().pg(REF, 'db')
const volDir = (): string => layout().vol(REF, VOL_ID)
/** The managed data id as PERSISTED state carries it. Legacy state has none and the migration
 *  mints one, so a test that hardcoded it was asserting against a fixture, not against the
 *  registration every later engine operation reads. The placeholder is deliberately an id no
 *  directory can have, so calling this before a boot fails loudly instead of quietly matching. */
const managedDataId = (): string => loadState().projects[PROJECT_ID].managedServices?.[0]?.dataId ?? 'not-minted-yet'
const mdDir = (ref = REF): string => layout().md(ref, 'redis', managedDataId())
const branchRow = (): Record<string, unknown> => loadState().branches[BRANCH_ID] as unknown as Record<string, unknown>
const dbRow = (): { container?: string; url?: string; dataId?: string } =>
  (loadState().branches[BRANCH_ID].databases?.['pg-db'] ?? {}) as { container?: string; url?: string; dataId?: string }
/** Relative paths under a data directory, sorted: what actually landed. */
const contentsOf = (dir: string): string[] => world.under(dir).map((p) => p.slice(dir.length + 1)).sort()

/** One boot. Returns the result; a `Killed` inside a branch surfaces as that branch's failure,
 *  which is what the next boot has to cope with. */
const boot = (): Promise<Awaited<ReturnType<typeof migrateLegacyData>>> => migrateLegacyData(deps)

/** Every data directory this file has made, newest last: `afterEach` removes each one, and the
 *  last case proves it (eleven of these were being left in the temp directory per run). */
const dataRoots: string[] = []

afterEach(() => {
  const dir = dataRoots[dataRoots.length - 1]
  if (dir) rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  world = new World()
  hooks.budget = Infinity
  hooks.onRename = undefined
  hooks.appendHba = undefined
  hooks.unreadable = undefined
  copied = 0
  const dir = mkdtempSync(join(tmpdir(), 'io-mig-unit-'))
  dataRoots.push(dir)
  cfg = loadConfig({ INSTA_OSS_MODE: 'local', INSTA_OSS_DATA_DIR: dir, INSTA_OSS_STATE: join(dir, 'state.json'), INSTA_OSS_SCHEDULER: '0' }, [])
  initStatePath(cfg.statePath)
  writeLegacyState()
  vi.mocked(pgAppendHba).mockClear()

  // the pre-scaffold install: a postgres under the old name with its PGDATA in the image's own
  // anonymous volume, and a docker NAMED volume holding the compute service's /data.
  world.containers.set(LEGACY_PG, { running: true, mounts: [] })
  world.sources.set(LEGACY_PG, PGDATA_FILES)
  world.containers.set(APP, { running: true, mounts: [`/var/lib/docker/volumes/${LEGACY_VOL}/_data`] })
  world.volumes.add(LEGACY_VOL)
  world.sources.set(`volume:${LEGACY_VOL}`, VOL_FILES)

  const data = makeData()
  deps = {
    cfg, data,
    layout,
    ref: (b) => b.ref,
    query: async () => '',
    provisionManaged: async (t) => { world.run(t.container, [t.dataDir]) },
    redeploy: async (_p, _b, group) => {
      world.containers.delete(appContainer(group))
      world.run(appContainer(group), [layout().vol(REF, VOL_ID)])
    },
  }
})

// ---- G/H. a docker that cannot answer ----

test('G: a probe that cannot ANSWER leaves the branch unmigrated, and stops nothing', async () => {
  // The stamp is the irreversible write: `assertMigrated` is fail-closed against `dataVersion`,
  // and nothing ever re-runs a stamped branch, so a branch stamped on a non-answer keeps its
  // bytes in a docker volume that a `docker rm -v` can take, for good. `{{.State.Running}}` is
  // the sharpest of these: the container IS there (`{{.Id}}` answers), and reading a daemon
  // that cannot answer as `false` used to stop a database that was running.
  hooks.unreadable = (a) => a[0] === 'inspect' && a[2] === '{{.State.Running}}'
  const out = await boot()
  expect(out.migrated).toEqual([])
  expect(out.failed).toHaveLength(1)
  expect(out.failed[0].error).toContain('docker could not report')
  expect(branchRow().dataVersion).toBeUndefined()
  // Nothing was stopped, removed or copied on the strength of a non-answer.
  expect(world.log.filter((l) => l.startsWith('stop:') || l.startsWith('rm:') || l.startsWith('volume rm:'))).toEqual([])
  expect(world.containers.get(LEGACY_PG)?.running).toBe(true)

  // ...and the next boot, with the daemon answering, does the whole migration.
  hooks.unreadable = undefined
  expect((await boot()).migrated).toEqual([REF])
  expect(branchRow().dataVersion).toBe(1)
  expect(contentsOf(pgDir())).toContain('global/pg_control')
})

test('I: a STOP that fails copies nothing and removes nothing, on both arms', async () => {
  // The stop was `.catch(() => {})` on both arms, commented "already down" -- one of the things
  // a failed stop means, and not the one that matters. The others are "still running", and the
  // step after the copy is `docker rm -f -v`, which deletes the anonymous volume holding the
  // only authoritative copy. So a stop that failed while the database was live took a
  // file-level copy of a running Postgres and then destroyed the source. The path-existence
  // check does not save it: that proves the copy did not stop early, not that it is
  // crash-consistent.
  writeLegacyState({ managed: true, managedDataId: 'cache' })
  world.containers.set(MD_REDIS, { running: true, mounts: [] })
  world.sources.set(MD_REDIS, REDIS_FILES)
  hooks.unreadable = (a) => a[0] === 'stop'      // the stop fails; the container stays running

  const out = await boot()
  expect(out.migrated).toEqual([])
  expect(out.failed).toHaveLength(1)
  expect(out.failed[0].error).toContain(`could not stop ${LEGACY_PG}`)
  expect(out.failed[0].error).toContain('crash-consistent')

  // Nothing was copied out of the live container, nothing was removed, and the branch is not
  // stamped: the source is exactly as it was and the next boot retries.
  expect(world.paths.has(pgDir())).toBe(false)
  expect(world.containers.has(LEGACY_PG)).toBe(true)
  expect(world.sources.get(LEGACY_PG)).toEqual(PGDATA_FILES)
  expect(world.log.filter((l) => l.startsWith('rm:'))).toEqual([])
  expect(world.log.filter((l) => l.startsWith('copy:'))).toEqual([])
  expect(branchRow().dataVersion).toBeUndefined()

  // The MANAGED arm has the identical sequence. Let postgres through and fail only its stop.
  hooks.unreadable = (a) => a[0] === 'stop' && a[1] === MD_REDIS
  const second = await boot()
  expect(second.failed).toHaveLength(1)
  expect(second.failed[0].error).toContain(`could not stop ${MD_REDIS}`)
  expect(world.containers.has(MD_REDIS)).toBe(true)
  expect(world.sources.get(MD_REDIS)).toEqual(REDIS_FILES)
  expect(world.paths.has(`${mdDir()}/data`)).toBe(false)
  expect(branchRow().dataVersion).toBeUndefined()

  // ...and with docker answering, the whole thing migrates.
  hooks.unreadable = undefined
  expect((await boot()).migrated).toEqual([REF])
  expect(contentsOf(`${mdDir()}/data`)).toEqual(['appendonly.aof', 'dump.rdb'])
  expect(contentsOf(pgDir())).toContain('global/pg_control')
})

test('H: a volume probe that cannot answer is not "there is no volume"', async () => {
  // `volume inspect` failing used to read as "no legacy volume, nothing to copy", and the branch
  // was stamped with the compute service's /data still in a named volume.
  hooks.unreadable = (a) => a[0] === 'volume' && a[1] === 'inspect'
  const out = await boot()
  expect(out.failed).toHaveLength(1)
  expect(out.failed[0].error).toContain(`could not report whether volume ${LEGACY_VOL} exists`)
  expect(branchRow().dataVersion).toBeUndefined()
  expect(world.volumes.has(LEGACY_VOL)).toBe(true)

  // The postgres arm ran before it, and the retry is safe because every step is resumable.
  hooks.unreadable = undefined
  expect((await boot()).migrated).toEqual([REF])
  expect(branchRow().dataVersion).toBe(1)
  expect(contentsOf(volDir())).toEqual(['keep.txt', 'nested', 'nested/deep.bin'])
  expect(world.volumes.has(LEGACY_VOL)).toBe(false)
})

// ---- the whole thing, uninterrupted ----

test('an uninterrupted migration moves every byte, then removes the sources, in that order', async () => {
  const out = await boot()
  expect(out).toEqual({ migrated: [REF], skipped: [], failed: [] })

  expect(contentsOf(pgDir())).toEqual([
    'PG_VERSION', 'base', 'base/1', 'base/1/1259', 'base/5', 'base/5/2608',
    'global', 'global/pg_control', 'pg_hba.conf', 'pg_wal', 'pg_wal/000000010000000000000001', 'postgresql.conf',
  ])
  expect(contentsOf(volDir())).toEqual(['keep.txt', 'nested', 'nested/deep.bin'])
  expect(world.containers.has(LEGACY_PG)).toBe(false)
  expect(world.containers.get(NEW_PG)?.mounts).toEqual([pgDir()])
  expect(world.volumes.has(LEGACY_VOL)).toBe(false)
  expect(branchRow().dataVersion).toBe(1)
  expect(dbRow()).toMatchObject({ container: NEW_PG, url: `postgres://postgres:${PG_PASSWORD}@${NEW_PG}:5432/app`, dataId: 'db' })

  // The ordering the whole finding is about: the promotion of the copy comes BEFORE the removal of
  // the source, in both lanes. Nothing is deleted while its replacement is unproven.
  const order = world.log
  expect(order.indexOf(`rename:${stagingOf(pgDir())}->${pgDir()}`)).toBeLessThan(order.indexOf(`rm:${LEGACY_PG}`))
  expect(order.indexOf(`rename:${stagingOf(volDir())}->${volDir()}`)).toBeLessThan(order.indexOf(`volume rm:${LEGACY_VOL}`))
  // ...and no staging directory is left lying about.
  expect(world.paths.has(stagingOf(pgDir()))).toBe(false)
  expect(world.paths.has(stagingOf(volDir()))).toBe(false)
})

// ---- A. postgres, killed mid-copy ----

test('A: killed mid-copy, the legacy postgres survives and the next boot copies the WHOLE PGDATA', async () => {
  // Two entries in, which in a real copy is past `PG_VERSION` and nowhere near `base/`.
  hooks.budget = 2
  const first = await boot()
  expect(first.migrated).toEqual([])
  expect(first.failed[0].error).toContain(`killed after 2 entries, inside ${LEGACY_PG}`)

  // The source is untouched (stopped, but there), and nothing was stamped.
  expect(world.containers.has(LEGACY_PG)).toBe(true)
  expect(world.sources.get(LEGACY_PG)).toEqual(PGDATA_FILES)
  expect(branchRow().dataVersion).toBeUndefined()
  // The half-copy is NOT at the destination: the destination does not exist at all, so nothing can
  // read it as a finished migration. It sits in staging, which the next boot throws away.
  expect(world.paths.has(pgDir())).toBe(false)
  expect(contentsOf(stagingOf(pgDir()))).toContain('PG_VERSION')

  hooks.budget = Infinity
  const second = await boot()
  expect(second).toEqual({ migrated: [REF], skipped: [], failed: [] })
  // Every file, not the two the interrupted run managed.
  for (const f of PGDATA_FILES) expect(world.paths.has(`${pgDir()}/${f}`)).toBe(true)
  expect(world.containers.has(LEGACY_PG)).toBe(false)
  expect(dbRow().container).toBe(NEW_PG)
})

// ---- B. postgres, copied but not promoted ----

test('B: killed after a complete copy and before the promotion, the source is still there', async () => {
  hooks.onRename = () => { throw new Killed('killed before the promotion') }
  const first = await boot()
  expect(first.failed[0].error).toContain('killed before the promotion')

  // The copy finished, but nothing was promoted, so the destination still does not exist -- and
  // crucially the legacy container was NOT removed on the strength of an unpromoted copy.
  expect(world.paths.has(pgDir())).toBe(false)
  expect(world.containers.has(LEGACY_PG)).toBe(true)
  expect(world.containers.has(NEW_PG)).toBe(false)
  expect(branchRow().dataVersion).toBeUndefined()

  hooks.onRename = undefined
  const second = await boot()
  expect(second).toEqual({ migrated: [REF], skipped: [], failed: [] })
  for (const f of PGDATA_FILES) expect(world.paths.has(`${pgDir()}/${f}`)).toBe(true)
  expect(world.containers.has(LEGACY_PG)).toBe(false)
  expect(dbRow().container).toBe(NEW_PG)
})

// ---- C. postgres, container created but state not written ----

test('C: killed after the replacement container and before the state write, the next boot finishes it', async () => {
  hooks.appendHba = () => { throw new Killed('killed after docker run') }
  const first = await boot()
  expect(first.failed[0].error).toContain('killed after docker run')

  // What the next boot inherits: the new container exists, the legacy one is gone, and the state
  // row STILL names the container that was deleted.
  expect(world.containers.has(NEW_PG)).toBe(true)
  expect(world.containers.has(LEGACY_PG)).toBe(false)
  expect(dbRow().container).toBe(LEGACY_PG)
  expect(branchRow().dataVersion).toBeUndefined()

  hooks.appendHba = undefined
  const second = await boot()
  // Not "already migrated": the row is what settles it, so this boot re-asserts the container and
  // writes the row. Without that, the branch is stamped `dataVersion: 1` while its credentials
  // point at a container that no longer exists.
  expect(second).toEqual({ migrated: [REF], skipped: [], failed: [] })
  expect(dbRow()).toMatchObject({ container: NEW_PG, url: `postgres://postgres:${PG_PASSWORD}@${NEW_PG}:5432/app`, dataId: 'db' })
  expect(branchRow().dataVersion).toBe(1)
  expect(world.containers.has(NEW_PG)).toBe(true)
  // The bytes were not copied a second time: the destination was already whole.
  expect(world.log.filter((l) => l.startsWith(`copy:${LEGACY_PG}`))).toHaveLength(1)

  // A third boot is the ordinary no-op.
  expect(await boot()).toEqual({ migrated: [], skipped: [REF], failed: [] })
})

test('C2: a database the developer had STOPPED is still stopped after a crash-resume', async () => {
  // The state a run killed between its `docker stop` and its state write leaves: the replacement
  // is there and stopped, the legacy container is gone, and no row names either.
  world.containers.delete(LEGACY_PG)
  world.containers.set(NEW_PG, { running: false, mounts: [pgDir()] })
  for (const f of PGDATA_FILES) world.add(`${pgDir()}/${f}`)

  expect((await boot()).failed).toEqual([])
  expect(dbRow().container).toBe(NEW_PG)
  // The resume reads the lifecycle intent back off the container nothing names, rather than
  // defaulting to "running" and waking a database the developer had put to sleep.
  expect(world.containers.get(NEW_PG)?.running).toBe(false)
})

// ---- D. compute volume, killed mid-copy ----

test('D: killed mid-volume-copy, the named volume survives and the next boot copies all of it', async () => {
  // Let postgres through untouched, then interrupt the volume copy one entry in.
  hooks.budget = PGDATA_FILES.length + 1
  const first = await boot()
  expect(first.failed[0].error).toContain(`inside volume:${LEGACY_VOL}`)

  expect(world.volumes.has(LEGACY_VOL)).toBe(true)
  expect(world.sources.get(`volume:${LEGACY_VOL}`)).toEqual(VOL_FILES)
  // Nothing at the destination, so no boot can mistake the half-copy for the whole one and drop
  // the volume that still holds it.
  expect(world.paths.has(volDir())).toBe(false)

  hooks.budget = Infinity
  const second = await boot()
  expect(second).toEqual({ migrated: [REF], skipped: [], failed: [] })
  expect(contentsOf(volDir())).toEqual(['keep.txt', 'nested', 'nested/deep.bin'])
  expect(world.volumes.has(LEGACY_VOL)).toBe(false)
  expect(world.containers.get(APP)?.mounts).toEqual([volDir()])
})

test('D2: an EMPTY /data volume migrates once and is never re-copied over the live app', async () => {
  // A `/data` nobody has written to yet. Its copy is empty, and so is its destination.
  world.sources.set(`volume:${LEGACY_VOL}`, [])
  await boot()
  expect(world.containers.get(APP)?.mounts).toEqual([volDir()])

  // Now the boot that follows one killed before the `dataVersion` stamp, with a `volume rm` that
  // did not take ("still referenced") and an app that has been writing to the bind mount since.
  // Reading "the destination is empty" as "the copy never happened" would copy the empty volume
  // over live data; the app's own mount is the honest record of what already moved.
  mutate((st) => { delete st.branches[BRANCH_ID].dataVersion })
  world.volumes.add(LEGACY_VOL)
  world.sources.set(`volume:${LEGACY_VOL}`, [])
  world.add(`${volDir()}/written-after-the-migration`)
  const again = await boot()
  expect(again.failed).toEqual([])
  expect(contentsOf(volDir())).toEqual(['written-after-the-migration'])
  expect(world.volumes.has(LEGACY_VOL)).toBe(false)
})

// ---- E/F. managed databases ----

test('E: killed mid-copy of a managed database, its container survives and the next boot finishes', async () => {
  writeLegacyState({ managed: true })
  world.containers.set(MD_REDIS, { running: true, mounts: [] })
  world.sources.set(MD_REDIS, REDIS_FILES)

  hooks.budget = PGDATA_FILES.length + VOL_FILES.length + 1
  const first = await boot()
  expect(first.failed[0].error).toContain(`inside ${MD_REDIS}`)
  expect(world.containers.has(MD_REDIS)).toBe(true)
  expect(world.sources.get(MD_REDIS)).toEqual(REDIS_FILES)
  expect(world.paths.has(`${mdDir()}/data`)).toBe(false)

  hooks.budget = Infinity
  const second = await boot()
  expect(second).toEqual({ migrated: [REF], skipped: [], failed: [] })
  expect(contentsOf(`${mdDir()}/data`)).toEqual(['appendonly.aof', 'dump.rdb'])
  expect(world.containers.get(MD_REDIS)?.mounts).toEqual([mdDir()])
})

test('F: killed between removing the managed container and re-creating it, the next boot re-creates it', async () => {
  writeLegacyState({ managed: true })
  world.containers.set(MD_REDIS, { running: true, mounts: [] })
  world.sources.set(MD_REDIS, REDIS_FILES)

  // The one gap this step cannot close by ordering: the replacement reuses the legacy NAME, so the
  // removal has to come first.
  const provision = deps.provisionManaged
  deps.provisionManaged = async () => { throw new Killed('killed before the re-create') }
  const first = await boot()
  expect(first.failed[0].error).toContain('killed before the re-create')
  expect(world.containers.has(MD_REDIS)).toBe(false)
  expect(contentsOf(`${mdDir()}/data`)).toEqual(['appendonly.aof', 'dump.rdb'])

  deps.provisionManaged = provision
  const second = await boot()
  expect(second).toEqual({ migrated: [REF], skipped: [], failed: [] })
  // The service came back on its bind mount rather than staying gone: the data directory is the
  // record that this migration had started.
  expect(world.containers.get(MD_REDIS)?.mounts).toEqual([mdDir()])
  expect(contentsOf(`${mdDir()}/data`)).toEqual(['appendonly.aof', 'dump.rdb'])
})

test('a legacy managed service gets ONE data id, and every branch is copied under it', async () => {
  // `dataId` is PROJECT level: every branch's directory is `md/<ref>/<prefix>-<dataId>`. A
  // pre-scaffold registration has none, and it was minted inside the per-branch loop, from a
  // project object loaded ONCE before that loop: the mint wrote to persisted state and left the
  // in-memory row untouched, so the next branch saw no id and minted another. Each branch's
  // files landed under its own id, the registration kept only the last, and every later engine
  // operation derives every branch's path from that one -- so the earlier branches' directories
  // were unreferenced, and gone with the next container recreate. Silent: the migration reports
  // success and the data is simply not where anything looks for it.
  writeLegacyState({ managed: true, secondBranch: true })
  for (const c of [MD_REDIS, MD_REDIS_2]) {
    world.containers.set(c, { running: true, mounts: [] })
    world.sources.set(c, REDIS_FILES)
  }

  const out = await boot()
  expect(out.failed).toEqual([])
  expect(out.migrated.sort()).toEqual([REF, REF2].sort())

  // The lookup every later operation performs, AFTER a state reload: one id, read back off the
  // registration, and both branches' bytes under it.
  const id = managedDataId()
  expect(id).not.toBe('not-minted-yet')
  for (const ref of [REF, REF2]) {
    const dir = layout().md(ref, 'redis', id)
    expect(contentsOf(`${dir}/data`), ref).toEqual(['appendonly.aof', 'dump.rdb'])
    expect(world.containers.get(`io-${ref}-rd-cache`)?.mounts, ref).toEqual([dir])
  }

  // ...and nothing landed under a SECOND id: one directory name across both branches.
  const mdRoot = join(cfg.dataDir, 'md')
  const dirIds = new Set([...world.paths]
    .filter((x) => x.startsWith(`${mdRoot}/`))
    .map((x) => x.slice(mdRoot.length + 1).split('/')[1])
    .filter(Boolean))
  expect([...dirIds]).toEqual([`rd-${id}`])
})

test('a redis whose /data holds nothing is still migrated, and only once', async () => {
  writeLegacyState({ managed: true })
  world.containers.set(MD_REDIS, { running: true, mounts: [] })
  world.sources.set(MD_REDIS, [])   // no dump.rdb yet: an empty data path is legitimate

  expect(await boot()).toEqual({ migrated: [REF], skipped: [], failed: [] })
  expect(world.containers.get(MD_REDIS)?.mounts).toEqual([mdDir()])
  expect(await boot()).toEqual({ migrated: [], skipped: [REF], failed: [] })
})

// ---- a PARTIAL destination in the other two lanes ----
//
// The same class as the PGDATA case below, in the lanes it survived in. A build that predates the
// staging discipline copied straight into the destination, so an install migrated by one and
// interrupted has a target with SOME of the files in it. Reading "not empty" as "already copied"
// skips the recopy, and the step after it removes the source.

test('a PARTIAL /data target is recopied rather than taken for a finished one', async () => {
  // One of the volume's two entries is at the destination: an interrupted direct copy.
  world.add(`${volDir()}/keep.txt`)

  const out = await boot()
  expect(out).toEqual({ migrated: [REF], skipped: [], failed: [] })
  // Everything, not just the entry that happened to be there first.
  expect(contentsOf(volDir())).toEqual(['keep.txt', 'nested', 'nested/deep.bin'])
  expect(world.log.filter((l) => l.startsWith(`copy:volume:${LEGACY_VOL}`))).toHaveLength(1)
  expect(world.containers.get(APP)?.mounts).toEqual([volDir()])
  // ...and only then is the volume that held the missing entry taken away.
  const order = world.log
  expect(order.indexOf(`rename:${stagingOf(volDir())}->${volDir()}`)).toBeLessThan(order.indexOf(`volume rm:${LEGACY_VOL}`))
})

test('a PARTIAL managed data path is recopied rather than taken for a finished one', async () => {
  // The install this models is one whose EARLIER migration was interrupted mid-copy, so its
  // registration already carries the id its partial directory was written under. Seeding
  // without that id is what made this test vacuous: `mdDir()` reads the id from live state, the
  // seed landed under the `not-minted-yet` placeholder, the migration minted a fresh id and
  // copied elsewhere, and the case never had a partial destination in it at all. The
  // placeholder fails loudly on a READ and silently creates a directory on a WRITE, which is
  // why nothing said so.
  writeLegacyState({ managed: true, managedDataId: 'cache' })
  world.containers.set(MD_REDIS, { running: true, mounts: [] })
  world.sources.set(MD_REDIS, REDIS_FILES)
  const seeded = `${mdDir()}/data`
  world.add(`${seeded}/dump.rdb`)   // half of an interrupted direct copy

  expect(await boot()).toEqual({ migrated: [REF], skipped: [], failed: [] })
  // THE GUARD: the seed has to be where the migration copies, or this case asserts nothing
  // about a partial destination. A misplaced fixture fails here instead of passing quietly.
  expect(`${mdDir()}/data`).toBe(seeded)
  expect(contentsOf(seeded)).toEqual(['appendonly.aof', 'dump.rdb'])
  expect(world.containers.get(MD_REDIS)?.mounts).toEqual([mdDir()])
  // ...and nothing was written under any OTHER id, which is the other way the seed could have
  // been misdirected.
  const mdRoot = join(cfg.dataDir, 'md', REF)
  const dirs = new Set([...world.paths].filter((x) => x.startsWith(`${mdRoot}/`)).map((x) => x.slice(mdRoot.length + 1).split('/')[0]))
  expect([...dirs].sort()).toEqual(['rd-cache'])
})

test('a non-empty target with NO app container is left alone, and its volume is kept', async () => {
  // The other reading of the same evidence, and the reason the recopy is not unconditional: with
  // no container naming either copy, the target may be what a finished migration left and a
  // since-removed app wrote to. Copying the volume over it would be the same data loss in the
  // other direction, so nothing is copied and nothing is deleted.
  world.containers.delete(APP)
  world.add(`${volDir()}/written-after-the-migration`)

  expect((await boot()).failed).toEqual([])
  expect(contentsOf(volDir())).toEqual(['written-after-the-migration'])
  expect(world.log.filter((l) => l.startsWith(`copy:volume:${LEGACY_VOL}`))).toEqual([])
  // The source is KEPT for the operator rather than removed on a guess...
  expect(world.volumes.has(LEGACY_VOL)).toBe(true)
  // ...and the service is back on the bind mount either way.
  expect(world.containers.get(APP)?.mounts).toEqual([volDir()])
})

// ---- the destination check itself ----

test('a PGDATA holding only PG_VERSION is not a migrated PGDATA', async () => {
  // Exactly the shape an interrupted copy used to leave AT the destination. Put it there by hand
  // (an install migrated by an older build could carry one) and the migration must recopy rather
  // than take it for finished and delete the source.
  world.add(`${pgDir()}/PG_VERSION`)
  const out = await boot()
  expect(out).toEqual({ migrated: [REF], skipped: [], failed: [] })
  for (const f of PGDATA_FILES) expect(world.paths.has(`${pgDir()}/${f}`)).toBe(true)
  expect(world.log.filter((l) => l.startsWith(`copy:${LEGACY_PG}`))).toHaveLength(1)
})

// ---- the suite's own footprint ----

test('every case cleans up its temp data directory', () => {
  // This case's own root is still live (its `afterEach` has not run yet); every earlier one has
  // been through `afterEach` and must be gone. The state file each of them holds is small, but
  // eleven directories per run in the developer's temp directory is a suite that litters.
  expect(dataRoots.slice(0, -1).filter((d) => existsSync(d))).toEqual([])
  expect(dataRoots.length).toBeGreaterThan(10)
})
