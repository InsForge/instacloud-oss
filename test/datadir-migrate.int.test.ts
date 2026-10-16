// Integration (real Docker): the one-time boot migration of an install that predates the data
// directory (04 section F, decision 24).
//
// Everything about this migration is about bytes that already exist, so nothing but a real
// pre-scaffold install can test it. This file BUILDS one: a Postgres container under the old name
// `io-<ref>-pg` with its PGDATA in the image's own anonymous volume, a docker NAMED volume
// `io-<ref>-data-<volId>` holding a compute service's `/data`, and a `state.json` in the shape a
// daemon wrote before any of `databases`, `dataId` or `dataVersion` existed. Then it runs the
// migration the daemon runs at boot and asks the four questions that matter:
//
//   1. the data survived: the rows are still there, read from the RE-CREATED container, and the
//      file is still there, read from the re-created app;
//   2. the bytes moved to where the layout says they live, off the container layer and off the
//      named volume, which is what makes a branch fork reflinkable at all;
//   3. the services still start: both containers are running afterwards, on their bind mounts;
//   4. re-running changes nothing. Twice over: once through the `dataVersion` stamp, and once with
//      the stamp cleared, which is the crash-before-the-stamp case the migration calls resumable.
//
// Run alone, by the integrator or CI:
//
//   RUN_DOCKER_TESTS=1 npx vitest run test/datadir-migrate.int.test.ts
//
// Platform: nothing here branches. The copy runs inside the `node:22-alpine` helper on every box
// (that is the only process that can read a PGDATA the postgres image chowned to its own uid), and
// `--reflink=auto` copies plainly where it cannot clone.
import { test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config'
import { docker } from '../src/docker'
import { dataLayout, sharedDataDir } from '../src/datadir'
import { initStatePath, loadState } from '../src/state'
import { Engine } from '../src/engine'
import { LocalPostgres, pgRun, pgWaitReady } from '../src/adapters/postgres'
import { DockerCompute } from '../src/adapters/compute'
import { LocalGarage } from '../src/adapters/garage'
import { LocalManagedDb } from '../src/adapters/manageddb'

/** Realpath'd: docker resolves a bind source itself, and on macOS `/var` is a symlink. */
const DATA = realpathSync(mkdtempSync(join(tmpdir(), 'io-mig-')))
const REF = 'migtest-main'
const NETWORK = `io-${REF}`
/** The pre-scaffold names: one postgres per branch, one named volume per compute service. */
const LEGACY_PG = `io-${REF}-pg`
const VOL_ID = 'a1b2c3d4'
const LEGACY_VOL = `io-${REF}-data-${VOL_ID}`
/** What the migration must produce. */
const NEW_PG = `io-${REF}-pg-db`
const APP = `io-${REF}-app-web`
const APP_PORT = 18101
const PG_PASSWORD = 'legacy-password-kept'
const MARKER = 'written-before-the-migration'

const cfg = loadConfig({
  INSTA_OSS_MODE: 'local',
  INSTA_OSS_DATA_DIR: DATA,
  INSTA_OSS_STATE: join(DATA, 'state.json'),
  INSTA_OSS_SCHEDULER: '0',
  INSTA_OSS_CREATE_GRACE_SEC: '0',
}, [])
const layout = dataLayout(DATA)
const data = sharedDataDir(cfg)
const pg = new LocalPostgres({ cfg, data })
const storage = new LocalGarage({ configPath: cfg.garageConfigPath, hostEndpoint: cfg.s3HostEndpoint, mode: cfg.mode, domain: cfg.domain })
const engine = new Engine(pg, new DockerCompute(), storage, new LocalManagedDb(), { cfg, data })

const PROJECT_ID = 'p-migtest'
const BRANCH_ID = 'b-migtest-main'

const inspect = async (nameOrId: string, fmt: string): Promise<string | null> => {
  try { return (await docker(['inspect', '-f', fmt, nameOrId])).toString().trim() } catch { return null }
}
const exists = async (container: string): Promise<boolean> => (await inspect(container, '{{.Id}}')) !== null
const volumeExists = async (volume: string): Promise<boolean> => {
  try { await docker(['volume', 'inspect', volume]); return true } catch { return false }
}
const branchRow = (): NonNullable<ReturnType<typeof loadState>['branches'][string]> => loadState().branches[BRANCH_ID]

/** Read the migrated PGDATA the way the DAEMON reads it: through a helper container on the same
 *  bind mount, exactly as `copyFromContainerVolume` does. The postgres image chowns PGDATA to its
 *  own uid at mode 0700, so an unprivileged test process cannot stat a file that is genuinely
 *  there; `existsSync` answered false for bytes the migration had just moved, which made this
 *  suite prove nothing about the one thing it guards. */
const existsInDataDir = async (path: string): Promise<boolean> => {
  const out = await docker(['run', '--rm', '--mount', `type=bind,src=${DATA},dst=${DATA}`,
    cfg.data.helperImage, 'sh', '-c', `if [ -e "${path}" ]; then printf yes; else printf no; fi`])
  return out.toString().trim() === 'yes'
}

/** state.json exactly as a pre-scaffold daemon wrote it: `dbUrl` and no `databases`, a
 *  `computeVolumes` entry for the named volume, and no `dataVersion` anywhere. */
function writeLegacyState(): void {
  const doc = {
    projects: {
      [PROJECT_ID]: {
        id: PROJECT_ID, name: 'migtest', status: 'ready', createdAt: 1,
        refSlug: 'migtest', computeGroups: ['web'],
        computeVolumes: { web: { id: VOL_ID, sizeGib: 1 } },
      },
    },
    branches: {
      [BRANCH_ID]: {
        id: BRANCH_ID, projectId: PROJECT_ID, name: 'main', isDefault: true, status: 'ready',
        ref: REF, network: NETWORK, cloneOf: null, createdAt: 1,
        dbUrl: `postgres://postgres:${PG_PASSWORD}@${LEGACY_PG}:5432/app`,
        apps: { web: { image: 'nginx:alpine', port: 80, hostPort: APP_PORT, url: `http://localhost:${APP_PORT}` } },
      },
    },
    policies: {}, approvals: [], events: [], userSecrets: {},
    rev: 1, auditRev: 0, customDomains: {}, templateDeployments: {},
  }
  writeFileSync(cfg.statePath, JSON.stringify(doc, null, 2), { mode: 0o600 })
}

beforeAll(async () => {
  initStatePath(cfg.statePath)
  await data.probe()
  await docker(['network', 'create', NETWORK]).catch(() => { /* already there */ })
  for (const c of [LEGACY_PG, NEW_PG, APP]) await docker(['rm', '-f', '-v', c]).catch(() => { /* not there */ })
  await docker(['volume', 'rm', LEGACY_VOL]).catch(() => { /* not there */ })

  // The legacy database: no bind mount at all, so PGDATA lands in the image's own anonymous volume.
  // That is the shape the data directory exists to end, and the reason `--volumes-from` is the only
  // way to read those bytes back out.
  await pgRun({ container: LEGACY_PG, network: NETWORK, dataDir: '' }, { publishLoopback: true },
    ['-e', `POSTGRES_PASSWORD=${PG_PASSWORD}`, '-e', 'POSTGRES_DB=app'])
  await pgWaitReady(LEGACY_PG)
  await pg.query(LEGACY_PG, 'create table notes(id int primary key, body text)')
  await pg.query(LEGACY_PG, "insert into notes values (1, 'before-the-migration'), (2, 'still-here')")

  // The legacy compute volume: a docker NAMED volume, which cannot be reflinked and dies with a
  // `docker rm -v`, mounted where the app expects its /data.
  await docker(['volume', 'create', LEGACY_VOL])
  await docker(['run', '--rm', '-v', `${LEGACY_VOL}:/data`, cfg.data.helperImage,
    'sh', '-c', `printf %s ${MARKER} > /data/keep.txt`])
  await docker(['run', '-d', '--restart', 'unless-stopped', '--name', APP, '--network', NETWORK,
    '-p', `127.0.0.1:${APP_PORT}:80`, '-v', `${LEGACY_VOL}:/data`, 'nginx:alpine'])

  writeLegacyState()
  // The pre-scaffold row really is pre-scaffold: no data version, and the handle still the old name.
  expect(branchRow().dataVersion).toBeUndefined()
  expect(branchRow().databases?.['pg-db']?.container).toBe(LEGACY_PG)
}, 600_000)

afterAll(async () => {
  for (const c of [LEGACY_PG, NEW_PG, APP]) await docker(['rm', '-f', '-v', c]).catch(() => { /* best effort */ })
  await docker(['volume', 'rm', LEGACY_VOL]).catch(() => { /* best effort */ })
  await docker(['network', 'rm', NETWORK]).catch(() => { /* best effort */ })
  // Same 0700-owned-by-the-image PGDATA: an unprivileged `rmSync` cannot even scandir it, which is
  // where the suite-level `EACCES: permission denied, scandir` came from. The container can.
  await docker(['run', '--rm', '--mount', `type=bind,src=${DATA},dst=${DATA}`,
    cfg.data.helperImage, 'sh', '-c', `rm -rf ${DATA}/pg ${DATA}/vol ${DATA}/md`])
    .catch(() => { /* best effort */ })
  rmSync(DATA, { recursive: true, force: true })
})

test('a pre-scaffold install migrates: the data survives, the services start, the old shapes are gone', async () => {
  const out = await engine.migrateLegacyData()
  expect(out.failed).toEqual([])
  expect(out.migrated).toEqual([REF])
  expect(out.skipped).toEqual([])

  // 1. the rows survived, read from the RE-CREATED container under its new name.
  expect(await exists(LEGACY_PG)).toBe(false)
  expect(await exists(NEW_PG)).toBe(true)
  expect(await inspect(NEW_PG, '{{.State.Running}}')).toBe('true')
  expect(await pg.query(NEW_PG, 'select body from notes order by id')).toBe('before-the-migration\nstill-here')

  // The files travelled, so the password travelled with them: only the DSN's host moved. Proved
  // over TCP, because unix-socket auth inside the container is trust and would pass regardless.
  const row = branchRow().databases?.['pg-db']
  expect(row?.container).toBe(NEW_PG)
  expect(row?.url).toBe(`postgres://postgres:${PG_PASSWORD}@${NEW_PG}:5432/app`)
  expect(branchRow().dbUrl).toBe(row?.url)
  const overTcp = await docker(['exec', NEW_PG, 'psql', `postgres://postgres:${PG_PASSWORD}@127.0.0.1:5432/app`, '-tAc', 'select count(*) from notes'])
  expect(overTcp.toString().trim()).toBe('2')

  // 2. the bytes are under the data directory now, at the layout's own path, and the container
  // reads them from a bind mount rather than a volume docker owns.
  const pgDir = layout.pg(REF, 'db')
  expect(pgDir).toBe(join(DATA, 'pg', REF, 'db'))
  expect(await data.hasPgData(pgDir)).toBe(true)
  expect(await inspect(NEW_PG, '{{range .Mounts}}{{.Type}}:{{.Source}} {{end}}')).toContain(`bind:${pgDir}`)

  const volDir = layout.vol(REF, VOL_ID)
  expect(readFileSync(join(volDir, 'keep.txt'), 'utf8')).toBe(MARKER)
  // 3. the app was re-created on the bind mount, is running, and still sees its own file.
  expect(await inspect(APP, '{{.State.Running}}')).toBe('true')
  expect(await inspect(APP, '{{range .Mounts}}{{.Type}}:{{.Source}} {{end}}')).toContain(`bind:${volDir}`)
  expect((await docker(['exec', APP, 'cat', '/data/keep.txt'])).toString()).toBe(MARKER)
  // ...and it kept the host mapping it was recorded with, on loopback.
  expect(await inspect(APP, '{{json .HostConfig.PortBindings}}')).toContain(`"HostIp":"127.0.0.1","HostPort":"${APP_PORT}"`)

  // The named volume is gone: nothing is left holding a second copy of those bytes.
  expect(await volumeExists(LEGACY_VOL)).toBe(false)

  // 4a. the branch is stamped, which is what stops the next boot doing any of this again.
  expect(branchRow().dataVersion).toBe(1)
}, 900_000)

test('re-running is a no-op, stamp or no stamp', async () => {
  const pgId = await inspect(NEW_PG, '{{.Id}}')
  const appId = await inspect(APP, '{{.Id}}')
  expect(pgId).toBeTruthy()
  expect(appId).toBeTruthy()

  // 4b. the ordinary next boot: the stamp answers before anything is inspected.
  const second = await engine.migrateLegacyData()
  expect(second).toEqual({ migrated: [], skipped: [REF], failed: [] })

  // 4c. and the case the migration calls resumable: a daemon killed after the copy and before the
  // stamp. With `dataVersion` cleared it re-examines everything, finds the legacy container gone
  // and the new one present, and touches nothing.
  const { mutate } = await import('../src/state')
  mutate((s) => { delete s.branches[BRANCH_ID].dataVersion })
  expect(branchRow().dataVersion).toBeUndefined()

  const third = await engine.migrateLegacyData()
  expect(third.failed).toEqual([])
  expect(third.migrated).toEqual([])
  expect(third.skipped).toEqual([REF])

  // Same containers, not replacements: no re-copy, no re-create, no restart.
  expect(await inspect(NEW_PG, '{{.Id}}')).toBe(pgId)
  expect(await inspect(APP, '{{.Id}}')).toBe(appId)
  expect(await pg.query(NEW_PG, 'select count(*) from notes')).toBe('2')
  expect(readFileSync(join(layout.vol(REF, VOL_ID), 'keep.txt'), 'utf8')).toBe(MARKER)
  // The stamp is back, so a fourth boot short-circuits again.
  expect(branchRow().dataVersion).toBe(1)
  // Nothing recreated the volume behind us.
  expect(await volumeExists(LEGACY_VOL)).toBe(false)
  expect(await existsInDataDir(join(DATA, 'pg', REF, 'db', 'PG_VERSION'))).toBe(true)
}, 600_000)
