// Integration (real Docker): a bundled template deployed end to end, twice, plus a second postgres
// service beside the first. Run by the integrator only:
//
//   RUN_DOCKER_TESTS=1 npx vitest run test/template-deploy.int.test.ts
//
// It pulls docker.io/n8nio/n8n:2.36.5 on a cold machine, so the whole file gets a generous timeout.
//
// The health probe is INJECTED here, and only because no daemon is listening in this process: the
// default probe dials `127.0.0.1:<cfg.port>` with the service's Host header, which is the router's
// HTTP lane (decision 58), and there is no router in a unit-style harness. The injected one dials
// the SAME container through its published loopback port, so the assertion the gate makes (this
// image really answers its declared healthcheck) is the same one. `test/router.int.test.ts` covers
// the lane itself.
import { test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config'
import { docker } from '../src/docker'
import { Engine } from '../src/engine'
import { LocalPostgres } from '../src/adapters/postgres'
import { DockerCompute } from '../src/adapters/compute'
import { LocalGarage } from '../src/adapters/garage'
import { LocalManagedDb } from '../src/adapters/manageddb'
import { TemplateExecutor } from '../src/templates/executor'

const cfg = loadConfig()
const storage = new LocalGarage({ configPath: cfg.garageConfigPath, hostEndpoint: cfg.s3HostEndpoint, mode: cfg.mode, domain: cfg.domain })
const engine = new Engine(new LocalPostgres(), new DockerCompute(), storage, new LocalManagedDb(), { cfg })
let projectId = ''

/** Dial the deployed container through the port local mode published for it. */
const probeViaLoopback = async (url: string, headers: Record<string, string>): Promise<number> => {
  const target = new URL(url)
  const branch = engine.listBranches(projectId).find((b) => b.name === 'main')
  const app = Object.values(branch?.apps ?? {}).find((a) => a.host === target.hostname)
  if (!app?.hostPort) return 0
  const res = await fetch(`http://127.0.0.1:${app.hostPort}${target.pathname}${target.search}`, { headers, redirect: 'manual' })
  return res.status
}
engine.executor = new TemplateExecutor(engine, { httpProbe: probeViaLoopback })

const teardown = async (): Promise<void> => { try { if (projectId) await engine.destroyProject(projectId) } catch { /* best effort */ } }

beforeAll(() => { process.env.INSTA_OSS_STATE = join(mkdtempSync(join(tmpdir(), 'io-tpl-')), 'state.json') })
afterAll(teardown)

test('deploying n8n on main reaches succeeded, answers its healthcheck and carries its generated key', async () => {
  const { project } = await engine.createProject('tplint')
  projectId = project.id

  const out = await engine.executor.create(projectId, { templateCode: 'n8n', branch: 'main' })
  expect(out.deployment.status).toBe('running')
  await engine.executor.idle()

  const view = engine.executor.get(out.deployment.id)
  expect(view.error ?? '').toBe('')
  expect(view.status).toBe('succeeded')
  expect(view.step).toBe('health_check')
  expect(view.services[0]).toMatchObject({ name: 'n8n', serviceId: 'cp-n8n', state: 'healthy' })
  // The recorded URL is the router's (`http://<group>-<ref>.localhost:<port>` in local mode).
  expect(view.services[0].url).toBe('http://n8n-tplint-main.localhost:8080')

  // The app really answers /healthz on the port local mode published for it.
  const branch = engine.listBranches(projectId).find((b) => b.name === 'main')!
  const hostPort = branch.apps.n8n.hostPort!
  const health = await fetch(`http://127.0.0.1:${hostPort}/healthz`, { headers: { Host: 'n8n-tplint-main.localhost' } })
  expect(health.status).toBe(200)

  // The container carries the generated key and the resolved service-ref values.
  const env = (await docker(['inspect', 'io-tplint-main-app-n8n', '--format', '{{json .Config.Env}}'])).toString()
  const vars = JSON.parse(env) as string[]
  const key = vars.find((v) => v.startsWith('N8N_ENCRYPTION_KEY='))!
  expect(key.slice('N8N_ENCRYPTION_KEY='.length)).toHaveLength(32)
  expect(vars).toContain('N8N_WEBHOOK_URL=http://n8n-tplint-main.localhost:8080')
  expect(vars).toContain('N8N_USER_FOLDER=/data')

  // alwaysOn and the /data volume the manifest asked for landed on the registration.
  const row = (await engine.services(projectId, 'main')).find((s) => s.id === 'cp-n8n')
  expect(row).toMatchObject({ always_on: true, volume_gib: cfg.templates.volumeGib, template_code: 'n8n' })
}, 600_000)

test('a second deploy into the same branch mints n8n-2 beside the first, and both remove cleanly', async () => {
  const out = await engine.executor.create(projectId, { templateCode: 'n8n', branch: 'main' })
  await engine.executor.idle()
  const second = engine.executor.get(out.deployment.id)
  expect(second.error ?? '').toBe('')
  expect(second.status).toBe('succeeded')

  const names = (await engine.services(projectId, 'main')).filter((s) => s.type === 'compute').map((s) => s.name).sort()
  expect(names).toEqual(['n8n', 'n8n-2'])
  // Two independent containers, each with its own generated key.
  const keyOf = async (group: string): Promise<string> => {
    const env = JSON.parse((await docker(['inspect', `io-tplint-main-app-${group}`, '--format', '{{json .Config.Env}}'])).toString()) as string[]
    return env.find((v) => v.startsWith('N8N_ENCRYPTION_KEY='))!
  }
  expect(await keyOf('n8n')).not.toBe(await keyOf('n8n-2'))

  for (const group of ['n8n', 'n8n-2']) {
    const t = await engine.removeComputeService(projectId, `cp-${group}`)
    expect(t.failed).toBe(0)
  }
  expect((await engine.services(projectId, 'main')).filter((s) => s.type === 'compute')).toEqual([])
}, 600_000)

test('a second postgres service is its own container, and its credentials connect over the lane', async () => {
  await engine.addDbService(projectId, 'db')
  const row = await engine.addDbService(projectId, 'analytics')
  expect(row).toMatchObject({ id: 'pg-analytics', type: 'postgres', name: 'analytics' })

  // Two containers, both running.
  const ps = (await docker(['ps', '--format', '{{.Names}}'])).toString()
  expect(ps).toContain('io-tplint-main-pg-db')
  expect(ps).toContain('io-tplint-main-pg-analytics')

  // The credentials route's DSN points at the lane, and the two are different databases.
  const creds = engine.credentials(projectId, 'pg-analytics', 'main')
  expect(creds.DATABASE_URL).toMatch(/^postgres:\/\/postgres:.+@127\.0\.0\.1:\d+\/app$/)
  const other = engine.credentials(projectId, 'pg-db', 'main').DATABASE_URL
  expect(creds.DATABASE_URL).not.toBe(other)

  // A table created through one is invisible to the other (separate instances, not schemas).
  const pg = new LocalPostgres()
  await pg.query('io-tplint-main-pg-analytics', 'create table only_here(id int);')
  expect(await pg.query('io-tplint-main-pg-analytics', "select count(*) from information_schema.tables where table_name='only_here';")).toBe('1')
  expect(await pg.query('io-tplint-main-pg-db', "select count(*) from information_schema.tables where table_name='only_here';")).toBe('0')

  // Removing one leaves the other, and reports what it destroyed.
  const t = await engine.removeDbService(projectId, 'pg-analytics')
  expect(t.failed).toBe(0)
  expect((await docker(['ps', '-a', '--format', '{{.Names}}'])).toString()).not.toContain('io-tplint-main-pg-analytics')
  expect((await engine.services(projectId, 'main')).filter((s) => s.type === 'postgres').map((s) => s.name)).toEqual(['db'])
}, 600_000)
