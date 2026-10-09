// Integration (real Docker): branch create copies the data and is isolated from main.
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
const pg = new LocalPostgres()
// postgres handles are container names: io-<ref>-pg-<name>
const MAIN = 'io-citest-main-pg-db'
const FEAT = 'io-citest-feat-pg-db'

const teardown = async () => { try { if (projectId) await engine.destroyProject(projectId) } catch {} }

beforeAll(async () => {
  process.env.INSTA_OSS_STATE = join(mkdtempSync(join(tmpdir(), 'io-int-')), 'state.json')
})
afterAll(teardown)

test('branch create copies data and is isolated', async () => {
  const { project } = await engine.createProject('citest')
  projectId = project.id
  // Project create provisions nothing (WP5): the container arrives with the postgres service.
  expect(await engine.addDbService(projectId, 'db')).toMatchObject({ id: 'pg-db', type: 'postgres', name: 'db', pg_version: 16 })

  await pg.query(MAIN, 'CREATE TABLE notes(id serial primary key, body text);')
  await pg.query(MAIN, "INSERT INTO notes(body) VALUES ('from-main');")

  await engine.createBranch(projectId, 'feat')
  // Contract section 13: a new branch's postgres is provisioned, readied and THEN slept, so the
  // fork is asleep from birth and its container is not running. Reaching it goes through a wake
  // door, and for a database the `api` door is a management call (decision 48) — which is what a
  // `psql` through the branch's lane would trigger for a developer.
  const featDb = (await engine.services(projectId, 'feat')).find((s) => s.name === 'db')
  expect(featDb).toMatchObject({ type: 'postgres', runtime: 'asleep' })
  await engine.dbListDatabases(projectId, 'feat')

  expect(await pg.query(FEAT, "SELECT count(*) FROM notes WHERE body='from-main';")).toBe('1')

  await pg.query(FEAT, "INSERT INTO notes(body) VALUES ('from-feat');")
  expect(await pg.query(MAIN, 'SELECT count(*) FROM notes;')).toBe('1') // main unchanged
  expect(await pg.query(FEAT, 'SELECT count(*) FROM notes;')).toBe('2')
  expect(await pg.query(MAIN, "SELECT count(*) FROM notes WHERE body='from-feat';")).toBe('0')
})

test('database management round-trip: create/list/delete db, extensions, insight, password', async () => {
  // databases: create → listed with its own connString → guarded + real deletes
  const created = await engine.dbCreateDatabase(projectId, 'analytics')
  expect(created.connString).toContain('/analytics')
  const listed = await engine.dbListDatabases(projectId)
  expect(listed.databases.map((d) => d.name)).toContain('analytics')
  await expect(engine.dbDeleteDatabase(projectId, 'app')).rejects.toThrow(/primary/)
  await engine.dbDeleteDatabase(projectId, 'analytics')
  expect((await engine.dbListDatabases(projectId)).databases.map((d) => d.name)).not.toContain('analytics')

  // extensions: enable a contrib module for real, then disable it; required stays protected
  const before = await engine.dbExtensions(projectId)
  expect(before.available.find((a) => a.name === 'pg_stat_statements')?.required).toBe(true)
  await engine.dbPatchExtensions(projectId, { enable: ['hstore'] })
  expect((await engine.dbExtensions(projectId)).enabled).toContain('hstore')
  await engine.dbPatchExtensions(projectId, { disable: ['hstore'] })
  expect((await engine.dbExtensions(projectId)).enabled).not.toContain('hstore')
  await expect(engine.dbPatchExtensions(projectId, { disable: ['pg_stat_statements'] })).rejects.toThrow(/required/)

  // insight: real sections off the live container (notes table exists from the clone test)
  const insight = await engine.dbInsight(projectId)
  expect(insight.collected).toBe(true)
  expect(insight.sizes.databaseBytes).toBeGreaterThan(0)
  expect(insight.tables.map((t) => t.name)).toContain('notes')

  // password: rotate, then authenticate OVER TCP with the new one (socket auth is trust)
  const { password, connString } = await engine.dbSetPassword(projectId, undefined)
  expect(connString).toContain(encodeURIComponent(password))
  const { docker } = await import('../src/docker')
  const out = await docker(['exec', MAIN, 'psql',
    `postgres://postgres:${encodeURIComponent(password)}@localhost:5432/app`, '-tAc', 'select 1'])
  expect(out.toString().trim()).toBe('1')
})
