// Integration (real Docker): the Postgres fork, both ways round (04 section D, decision 23).
//
// The fake-adapter suites pin the DECISIONS around a fork; only a real filesystem and a real
// postmaster can answer the four things this file exists for:
//
//   1. the method the adapter RECORDS is the method it used: `INSTA_OSS_FORK=auto` takes the
//      reflink path exactly when the boot probe says this data dir can clone AND the source is at
//      rest, streams a RUNNING source even on a box that could clone (a file-by-file walk of a live
//      data directory is not a crash-consistent copy), and `INSTA_OSS_FORK=basebackup` streams
//      everywhere;
//   2. the clone carries the source's bytes, its password among them (a file-level fork inherits
//      the source's roles, decision 18), on both paths;
//   3. the two are separate databases from the first write onwards: a write on the fork never
//      reaches the parent, and a write on the parent after the fork never reaches the clone;
//   4. `INSTA_OSS_FORK=reflink` REFUSES when the clone cannot reflink, instead of quietly streaming
//      a copy. That is the whole point of the strict setting (`main.ts` refuses the same way at
//      boot when the probe says no), and nothing covered it before this file.
//
// Run alone, by the integrator or CI:
//
//   RUN_DOCKER_TESTS=1 npx vitest run test/fork.int.test.ts
//
// It runs BOTH fork modes in one process, each on its own config, so a single run covers the pair;
// an outer `INSTA_OSS_FORK` in the environment changes nothing here. Everything is driven at the
// adapter, where the fork lives: `test/clone-isolation.int.test.ts` covers the same ground through
// `engine.createBranch`.
//
// Platform: this file never skips. Where the box's own data dir can reflink (APFS, XFS with
// `reflink=1`) the reflink path is exercised for real; where it cannot (ext4, overlayfs) the same
// assertions run against the stream, and `expectedAuto` is what keeps them honest.
import { test, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, type Config } from '../src/config'
import { docker } from '../src/docker'
import { dataLayout, forkMethod, sharedDataDir } from '../src/datadir'
import { LocalPostgres, pgWaitReady } from '../src/adapters/postgres'
import { NoReflinkError, type DataDirOps, type PgTarget } from '../src/types'

/** The data dir is REALPATH'd: docker resolves a bind source itself, and on macOS `/var` is a
 *  symlink into `/private/var`, so a mount written the other way silently binds a second path. */
const DATA = realpathSync(mkdtempSync(join(tmpdir(), 'io-fork-')))
const NETWORK = 'io-forktest'
const layout = dataLayout(DATA)

const cfgFor = (fork: 'auto' | 'reflink' | 'basebackup'): Config => loadConfig({
  INSTA_OSS_MODE: 'local',
  INSTA_OSS_DATA_DIR: DATA,
  INSTA_OSS_STATE: join(DATA, 'state.json'),
  INSTA_OSS_SCHEDULER: '0',
  INSTA_OSS_FORK: fork,
}, [])

/** The ONE DataDir of this process, probed once, exactly as `main.ts` boots it. It has to be the
 *  SHARED instance: the adapter's `forkMethod` reads the probe back through `probedCapabilities()`,
 *  which is that singleton, so a privately constructed DataDir would leave `auto` believing this
 *  box cannot clone. */
const data = sharedDataDir(cfgFor('auto'))
/** What `INSTA_OSS_FORK=auto` must resolve to ON THIS BOX for a source AT REST, from the real
 *  probe. A running source streams whatever the probe says. */
let expectedAuto: 'reflink' | 'basebackup' = 'basebackup'
/** The image every helper-container read and write in this file runs in (`node:22-alpine`). */
const HELPER_IMAGE = cfgFor('auto').data.helperImage

const containers: string[] = []
const target = (ref: string): PgTarget => {
  const container = `io-${ref}-pg-db`
  containers.push(container)
  return { container, network: NETWORK, dataDir: layout.pg(ref, 'db') }
}

beforeAll(async () => {
  await docker(['network', 'create', NETWORK]).catch(() => { /* already there */ })
  const caps = await data.probe()
  expectedAuto = caps.reflink ? 'reflink' : 'basebackup'
  // The probe and the selector must agree: `auto` follows the probe, the two overrides do not.
  expect(forkMethod(cfgFor('auto'), caps)).toBe(expectedAuto)
  expect(forkMethod(cfgFor('basebackup'), caps)).toBe('basebackup')
  expect(forkMethod(cfgFor('reflink'), caps)).toBe('reflink')
}, 120_000)

afterAll(async () => {
  for (const c of containers) await docker(['rm', '-f', '-v', c]).catch(() => { /* best effort */ })
  await docker(['network', 'rm', NETWORK]).catch(() => { /* best effort */ })
  // Every PGDATA under here is 0700 and owned by the image's own uid, so an unprivileged `rmSync`
  // cannot even scandir it. The helper container can, and that is the same reason the fallback
  // this file's last case pins exists at all.
  await docker(['run', '--rm', '--mount', `type=bind,src=${DATA},dst=${DATA}`,
    HELPER_IMAGE, 'sh', '-c', `rm -rf ${DATA}/pg ${DATA}/vol ${DATA}/md`])
    .catch(() => { /* best effort */ })
  rmSync(DATA, { recursive: true, force: true })
})

/** A parent with a seeded table, ready to fork. Returns the adapter, the handles and the DSN. */
async function seedParent(ref: string, fork: 'auto' | 'basebackup', over: { data?: DataDirOps } = {}): Promise<{
  pg: LocalPostgres; src: PgTarget & { url: string }
}> {
  const cfg = cfgFor(fork)
  const pg = new LocalPostgres({ cfg, data: over.data ?? data })
  const t = target(ref)
  const { url } = await pg.provision(t)
  await pg.query(t.container, 'create table notes(id int primary key, body text)')
  await pg.query(t.container, "insert into notes select g, 'seeded-' || g from generate_series(1, 20000) g")
  await pg.query(t.container, 'checkpoint')
  expect(await pg.query(t.container, 'select count(*) from notes')).toBe('20000')
  return { pg, src: { ...t, url } }
}

/** Put the parent to sleep, which is what a branch's parent normally is here: databases scale to
 *  zero, and a stopped data directory is the only one a file-level clone may copy. */
const sleepSource = (container: string): Promise<unknown> => docker(['stop', container])
/** ...and back, so the isolation assertions can query it. */
async function wakeSource(container: string): Promise<void> {
  await docker(['start', container])
  await pgWaitReady(container)
}

/** The four assertions every fork owes, whichever path it took. */
async function assertForkedAndIsolated(pg: LocalPostgres, src: PgTarget, dst: PgTarget): Promise<void> {
  // 2. the seeded rows travelled
  expect(await pg.query(dst.container, 'select count(*) from notes')).toBe('20000')
  expect(await pg.query(dst.container, 'select body from notes where id = 7')).toBe('seeded-7')

  // 3a. a write on the fork never reaches the parent
  await pg.query(dst.container, "insert into notes values (900001, 'from-fork')")
  expect(await pg.query(dst.container, "select count(*) from notes where body = 'from-fork'")).toBe('1')
  expect(await pg.query(src.container, "select count(*) from notes where body = 'from-fork'")).toBe('0')

  // 3b. and the parent is untouched: a write of its own after the fork stays on its side
  await pg.query(src.container, "insert into notes values (900002, 'from-parent')")
  expect(await pg.query(src.container, "select count(*) from notes where body = 'from-parent'")).toBe('1')
  expect(await pg.query(dst.container, "select count(*) from notes where body = 'from-parent'")).toBe('0')
  expect(await pg.query(src.container, 'select count(*) from notes')).toBe('20001')
  expect(await pg.query(dst.container, 'select count(*) from notes')).toBe('20001')
}

test('INSTA_OSS_FORK=auto records the method the probe chose, and the clone is a separate database', async () => {
  const { pg, src } = await seedParent('forktest-main', 'auto')
  const dst = target('forktest-feat')
  // Asleep, the ordinary state of a branch's parent here, and the only state a reflink clone is
  // allowed to copy: a live postmaster keeps writing all the way through the walk.
  await sleepSource(src.container)

  // The wake door the ENGINE hands to every fork (`engine.ts` passes `ensureSourceRunning`, a
  // `wake` on the source's ServiceKey, because moving a container from inside the adapter would
  // go behind the scheduler's back). The reflink path never opens it -- a source at rest is
  // precisely what that path wants -- and the stream cannot read a stopped server without it.
  // Handing it over is what makes this case honest on BOTH filesystems: where the data dir can
  // clone, the sleeping directory is cloned and the door stays shut; where it cannot (an ext4
  // runner), the parent is woken and streamed, exactly as a real `branch create` would.
  let doors = 0
  const out = await pg.fork(src, dst, { ensureSourceRunning: async () => { doors++; await wakeSource(src.container) } })

  // 1. the recorded method IS the mode's method on this box
  expect(out.method).toBe(expectedAuto)
  // The door is the difference between the two paths, so it is asserted rather than just offered.
  expect(doors).toBe(expectedAuto === 'reflink' ? 0 : 1)
  await wakeSource(src.container)
  expect(out.ms).toBeGreaterThanOrEqual(0)
  // A file-level fork inherits the source's password: only the host moves (decision 18).
  expect(out.url).toBe(src.url.replace(src.container, dst.container))
  expect(await docker(['inspect', '-f', '{{.State.Status}}', dst.container]).then((b) => b.toString().trim())).toBe('running')
  // The clone's PGDATA is its own directory under the data dir, never the source's.
  expect(dst.dataDir).not.toBe(src.dataDir)
  expect(await data.hasPgData(dst.dataDir)).toBe(true)

  await assertForkedAndIsolated(pg, src, dst)
}, 300_000)

test('a RUNNING source streams even where the box could have cloned, and the clone is consistent', async () => {
  // The reflink walk copies pg_control first and pg_wal last, file by file. A live server writes
  // through all of it (its own checkpoints, heap and index writes, files created and unlinked, WAL
  // recycled), so the destination would be assembled out of several different filesystem moments.
  // `auto` therefore streams a running source whatever the probe said about reflinks.
  const { pg, src } = await seedParent('forktest-live', 'auto')
  const dst = target('forktest-livefeat')

  // A writer that keeps committing rows for the whole fork, ids strictly increasing and one row
  // per transaction: a consistent copy holds SOME prefix of them, a torn one holds gaps (or does
  // not recover at all).
  let writing = true
  let written = 0
  const writer = (async () => {
    while (writing) {
      await pg.query(src.container, `insert into notes values (${100000 + written}, 'live-${written}')`)
      written++
    }
  })()

  const out = await pg.fork(src, dst)
  writing = false
  await writer

  expect(out.method).toBe('basebackup')
  expect(written).toBeGreaterThan(0)
  expect(await docker(['inspect', '-f', '{{.State.Status}}', dst.container]).then((b) => b.toString().trim())).toBe('running')
  // Consistency: whatever the clone caught of the concurrent writer is a contiguous prefix of it,
  // with no hole in the middle, and the seeded rows are all there.
  expect(await pg.query(dst.container, 'select count(*) from notes where id < 100000')).toBe('20000')
  const caught = Number(await pg.query(dst.container, 'select count(*) from notes where id >= 100000'))
  const highest = await pg.query(dst.container, 'select coalesce(max(id) - 100000 + 1, 0) from notes where id >= 100000')
  expect(caught).toBe(Number(highest))
  expect(caught).toBeLessThanOrEqual(written)

  // Separate databases from the first write onwards. The total-count assertions of
  // `assertForkedAndIsolated` cannot be reused here: the concurrent writer moved both totals.
  await pg.query(dst.container, "insert into notes values (900001, 'from-fork')")
  expect(await pg.query(src.container, "select count(*) from notes where body = 'from-fork'")).toBe('0')
  await pg.query(src.container, "insert into notes values (900002, 'from-parent')")
  expect(await pg.query(dst.container, "select count(*) from notes where body = 'from-parent'")).toBe('0')
}, 300_000)

test('INSTA_OSS_FORK=basebackup streams even where the box could have cloned, with the same guarantees', async () => {
  const { pg, src } = await seedParent('forktest-bb', 'basebackup')
  const dst = target('forktest-bbfeat')

  const out = await pg.fork(src, dst)

  expect(out.method).toBe('basebackup')
  expect(out.url).toBe(src.url.replace(src.container, dst.container))
  expect(await data.hasPgData(dst.dataDir)).toBe(true)

  await assertForkedAndIsolated(pg, src, dst)
}, 300_000)

/** A DataDir whose `clonePostgres` raises exactly what a filesystem without reflinks raises. On
 *  darwin the documented `INSTA_OSS_FSCLONE_FSTYPE` hook makes the REAL child program answer that
 *  way (`cp -c` cannot report its own fallback, so `--reflink=always` pre-checks the filesystem);
 *  on a box whose data dir genuinely cannot clone the real DataDir already does; anywhere else the
 *  wrapper raises the same NoReflinkError the child would, and every other verb stays real. */
function noReflinkData(): { data: DataDirOps; restore(): void } {
  if (expectedAuto !== 'reflink') return { data, restore: () => { /* the box already cannot clone */ } }
  if (process.platform === 'darwin') {
    const prev = process.env.INSTA_OSS_FSCLONE_FSTYPE
    process.env.INSTA_OSS_FSCLONE_FSTYPE = 'exfat'
    return {
      data,
      restore: () => {
        if (prev === undefined) delete process.env.INSTA_OSS_FSCLONE_FSTYPE
        else process.env.INSTA_OSS_FSCLONE_FSTYPE = prev
      },
    }
  }
  const wrapped: DataDirOps = {
    probe: () => data.probe(),
    ensureDir: (p, mode) => data.ensureDir(p, mode),
    clonePostgres: () => Promise.reject(new NoReflinkError('ENOTSUP')),
    cloneTree: (s, d) => data.cloneTree(s, d),
    remove: (p) => data.remove(p),
    rename: (src, dst) => data.rename(src, dst),
    copyFromContainerVolume: (s, c, d) => data.copyFromContainerVolume(s, c, d),
    hasPgData: (d) => data.hasPgData(d),
    isEmptyOrMissing: (d) => data.isEmptyOrMissing(d),
  }
  return { data: wrapped, restore: () => { /* nothing global was touched */ } }
}

test('INSTA_OSS_FORK=reflink refuses a fork it cannot reflink; auto streams one instead', async () => {
  const { pg: parent, src } = await seedParent('forktest-strict', 'auto')
  const strict = noReflinkData()
  // At rest, so what the strict setting refuses is the missing REFLINK and not the live source.
  await sleepSource(src.container)
  try {
    // Strict: the operator asked for reflinks and only reflinks. A stream here would be the silent
    // copy the setting exists to forbid, so the fork fails and says which setting refused it.
    const refusing = new LocalPostgres({ cfg: cfgFor('reflink'), data: strict.data })
    const refused = target('forktest-strictfeat')
    await expect(refusing.fork(src, refused)).rejects.toThrow(/INSTA_OSS_FORK=reflink/)
    // ...and it left no half-started clone behind claiming to be a database.
    await expect(docker(['inspect', '-f', '{{.State.Status}}', refused.container])).rejects.toThrow()

    // Same box, same failure, permissive setting: THIS one is allowed to stream, and it produces a
    // working fork. The contrast is the assertion: the fallback is a choice, not an accident.
    // The stream reads the source over the network, so it needs it up; the engine hands the
    // adapter a wake door for exactly this, and here the test opens it.
    await wakeSource(src.container)
    const permissive = new LocalPostgres({ cfg: cfgFor('auto'), data: strict.data })
    const streamed = target('forktest-strictok')
    const out = await permissive.fork(src, streamed)
    expect(out.method).toBe('basebackup')
    expect(await permissive.query(streamed.container, 'select count(*) from notes')).toBe('20000')
    await assertForkedAndIsolated(parent, src, streamed)
  } finally {
    strict.restore()
  }
}, 300_000)

/** The one box shape the helper fallback exists for: an unprivileged Linux daemon and bytes it is
 *  not allowed to read. macOS runs the `cp-c` engine and a root daemon reads everything, so neither
 *  has a fallback to observe; CI, an unprivileged ubuntu runner, is exactly where this bites. */
const canObserveHelperFallback = process.platform === 'linux' && process.getuid?.() !== 0

test.skipIf(!canObserveHelperFallback)('a source this daemon may not read is copied by the helper container, not failed', async () => {
  const base = join(DATA, 'vol', 'forktest-denied')
  const src = join(base, 'src')
  const dst = join(base, 'dst')
  mkdirSync(base, { recursive: true, mode: 0o700 })
  // Built by a container as root and left 0700 under a uid this process is not: exactly the shape
  // the postgres entrypoint leaves a PGDATA in, which is why an unprivileged daemon cannot read it.
  await docker(['run', '--rm', '--mount', `type=bind,src=${DATA},dst=${DATA}`, HELPER_IMAGE,
    'sh', '-c', `mkdir -p ${src} && printf 16 > ${src}/PG_VERSION && chown -R 999:999 ${src} && chmod 700 ${src}`])
  // The precondition, stated rather than assumed: the daemon's own process really cannot read it.
  expect(() => readdirSync(src)).toThrow(/EACCES|EPERM/)

  // Before the exit code existed this threw `Command failed: ... exit 1` from the child, because a
  // child's errno never reaches the parent: the fallback below could not tell a refusal from any
  // other failure, so `branch create` on an ordinary non-root Linux laptop failed outright.
  const out = await data.cloneTree(src, dst)
  expect(['reflink', 'copy']).toContain(out.method)

  // The bytes really landed, read back the only way this process can read them.
  const got = await docker(['run', '--rm', '--mount', `type=bind,src=${DATA},dst=${DATA}`,
    HELPER_IMAGE, 'cat', `${dst}/PG_VERSION`])
  expect(got.toString().trim()).toBe('16')
}, 300_000)
