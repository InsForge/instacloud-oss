// Integration (real Docker + Garage): storage branching = bucket copy, isolated; creds are bucket-scoped.
import { test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config'
import { Engine } from '../src/engine'
import { LocalPostgres } from '../src/adapters/postgres'
import { DockerCompute } from '../src/adapters/compute'
import { LocalGarage } from '../src/adapters/garage'
import { LocalManagedDb } from '../src/adapters/manageddb'

const cfg = loadConfig()
const storage = new LocalGarage({ configPath: cfg.garageConfigPath, hostEndpoint: cfg.s3HostEndpoint, mode: cfg.mode, domain: cfg.domain })
const engine = new Engine(new LocalPostgres(), new DockerCompute(), storage, new LocalManagedDb(), { cfg })
let projectId = ''
// bucket handles are io-<ref>-<name>
const MAIN_BUCKET = 'io-sttest-main-store'
const FEAT_BUCKET = 'io-sttest-feat-store'

const teardown = async () => { try { if (projectId) await engine.destroyProject(projectId) } catch {} }

beforeAll(() => { process.env.INSTA_OSS_STATE = join(mkdtempSync(join(tmpdir(), 'io-st-')), 'state.json') })
afterAll(teardown)

test('branch create copies the bucket; clone writes never touch the source bucket', async () => {
  const { project } = await engine.createProject('sttest')
  projectId = project.id
  // Project create provisions nothing (WP5): the bucket arrives with the storage service, whose
  // handle is `io-<ref>-<name>` on every branch.
  const row = await engine.addStorageService(projectId, 'store')
  expect(row).toMatchObject({ id: 'st-store', type: 'storage', name: 'store' })
  const mainNet = 'io-sttest-main'
  const featNet = 'io-sttest-feat'

  await storage.putObject(mainNet, MAIN_BUCKET, 'hello.txt', 'from-main')

  await engine.createBranch(projectId, 'feat')

  // clone received the object
  expect(await storage.getObject(featNet, FEAT_BUCKET, 'hello.txt')).toBe('from-main')

  // write only to the clone → source bucket unchanged
  await storage.putObject(featNet, FEAT_BUCKET, 'only-in-feat.txt', 'x')
  const mainList = await storage.listObjects(mainNet, MAIN_BUCKET)
  expect(mainList).toContain('hello.txt')
  expect(mainList).not.toContain('only-in-feat.txt')
})

test('branch credentials are scoped: a branch key cannot touch another branch bucket', async () => {
  // main's own creds work on main's bucket…
  const branches = engine.listBranches(projectId)
  const main = branches.find((b) => b.name === 'main')!
  expect(branches.map((b) => b.name).sort()).toEqual(['feat', 'main'])
  // The minted bundle of ONE storage service on ONE branch (the credentials route's own answer).
  const mainCreds = engine.credentials(projectId, 'st-store', 'main')
  const featCreds = engine.credentials(projectId, 'st-store', 'feat')
  expect(mainCreds.BUCKET_NAME).toBe(MAIN_BUCKET)
  expect(featCreds.BUCKET_NAME).toBe(FEAT_BUCKET)
  // The credential bundle is HOST-facing (contract section 10: `http://127.0.0.1:3900` in local
  // mode), and this probe runs INSIDE a container on the branch network, where the object store
  // answers to its own name. That is the same swap `envFor` makes for a deploy.
  expect(mainCreds.AWS_ENDPOINT_URL_S3).toBe('http://127.0.0.1:3900')
  const inContainerEndpoint = 'http://io-garage:3900'
  const rcloneAs = (creds: Record<string, string>, args: string[]) =>
    // same path the app takes: plain S3 with the branch's minted key
    import('../src/docker').then(({ docker }) => docker(['run', '--rm', '--network', main.network,
      '-e', 'RCLONE_CONFIG_G_TYPE=s3', '-e', 'RCLONE_CONFIG_G_PROVIDER=Other',
      '-e', `RCLONE_CONFIG_G_ENDPOINT=${inContainerEndpoint}`, '-e', 'RCLONE_CONFIG_G_REGION=garage',
      '-e', `RCLONE_CONFIG_G_ACCESS_KEY_ID=${creds.AWS_ACCESS_KEY_ID}`, '-e', `RCLONE_CONFIG_G_SECRET_ACCESS_KEY=${creds.AWS_SECRET_ACCESS_KEY}`,
      'rclone/rclone', ...args]))
  // own bucket readable
  expect((await rcloneAs(mainCreds, ['ls', `g:${mainCreds.BUCKET_NAME}`])).toString()).toContain('hello.txt')
  // foreign bucket: denied
  await expect(rcloneAs(mainCreds, ['ls', `g:${featCreds.BUCKET_NAME}`])).rejects.toThrow(/AccessDenied|Forbidden|exit/)
})

test('object ops round-trip on the host port: list → presigned GET → upload POST → delete', async () => {
  // list sees the object rclone put there (SigV4 against 127.0.0.1:3900)
  const listing = await engine.listServiceObjects(projectId, 'st-store', {})
  expect(listing.objects.map((o) => o.key)).toContain('hello.txt')

  // presigned GET is host-fetchable and carries the object bytes
  const dl = await engine.presignServiceObjectDownload(projectId, 'st-store', { key: 'hello.txt' })
  const got = await fetch(dl.url)
  expect(got.status).toBe(200)
  expect(await got.text()).toBe('from-main')

  // presigned POST uploads straight to the bucket (policy pins type + exact size)
  const body = 'posted-bytes'
  const up = await engine.presignServiceObjectUpload(projectId, 'st-store', { key: 'posted.txt', contentType: 'text/plain', size: body.length })
  const form = new FormData()
  for (const [k, v] of Object.entries(up.fields)) form.append(k, v)
  form.append('file', new Blob([body], { type: 'text/plain' }), 'posted.txt')
  const posted = await fetch(up.url, { method: 'POST', body: form })
  expect(posted.status, await posted.text().catch(() => '')).toBeLessThan(300)
  expect(await storage.getObject('io-sttest-main', MAIN_BUCKET, 'posted.txt')).toBe(body)

  // single + bulk delete
  expect(await engine.deleteServiceObject(projectId, 'st-store', { key: 'posted.txt' })).toEqual({ deleted: true })
  await storage.putObject('io-sttest-main', MAIN_BUCKET, 'b1.txt', 'x')
  await storage.putObject('io-sttest-main', MAIN_BUCKET, 'b2.txt', 'y')
  const bulk = await engine.deleteServiceObjects(projectId, 'st-store', { keys: ['b1.txt', 'b2.txt'] })
  expect(bulk.deleted).toBe(2)
  expect(bulk.failed).toEqual([])
  // The audit row counts what went, not what was asked for: a bulk delete over keys that are not
  // there must not read as a bulk delete that removed them.
  const gone = await engine.deleteServiceObjects(projectId, 'st-store', { keys: ['b1.txt', 'nope.txt'] })
  const rows = engine.listEvents(projectId).filter((e) => e.kind === 'storage.objects.delete')
  const last = rows[rows.length - 1]
  expect(last?.payload).toMatchObject({ requested: 2, count: gone.deleted })
  const after = await engine.listServiceObjects(projectId, 'st-store', {})
  expect(after.objects.map((o) => o.key)).not.toContain('b1.txt')
})
