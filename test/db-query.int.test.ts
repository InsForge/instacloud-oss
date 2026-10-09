// Integration (real Docker + Postgres): the ad-hoc query route's row transport, graded against a
// live server — a fake keyed on a substring of the generated SQL can only confirm the daemon
// built the substring, never that Postgres accepts it (review round 3 caught a wrapper that
// type-errored on EVERY statement while the suite stayed green).
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

const teardown = async () => { try { if (projectId) await engine.destroyProject(projectId) } catch {} }

beforeAll(() => { process.env.INSTA_OSS_STATE = join(mkdtempSync(join(tmpdir(), 'io-dbq-')), 'state.json') })
afterAll(teardown)

test('dbQuery against a real Postgres: text-exact values, order, zero rows, literals, commands', async () => {
  const { project } = await engine.createProject('dbqtest')
  projectId = project.id
  await engine.addDbService(projectId, 'db')

  // bigint and high-precision numeric survive as their exact text — the transport's whole point.
  const fidelity = await engine.dbQuery(projectId, 'select 9007199254740993::bigint as id, 12345678901234567890123.5::numeric as amt')
  expect(fidelity).toMatchObject({ columns: ['id', 'amt'], rows: [['9007199254740993', '12345678901234567890123.5']], rowCount: 1 })

  // Column order is the statement's, not alphabetical; null stays null.
  const order = await engine.dbQuery(projectId, "select null::int as z_first, 'x' as a_second")
  expect(order).toMatchObject({ columns: ['z_first', 'a_second'], rows: [[null, 'x']] })

  // Zero rows still answer the row shape.
  expect(await engine.dbQuery(projectId, 'select 1 as a where false')).toMatchObject({ columns: [], rows: [], rowCount: 0 })

  // A `;` inside a literal stays row-shaped and the value survives verbatim.
  expect(await engine.dbQuery(projectId, "select 'a;b' as v")).toMatchObject({ columns: ['v'], rows: [['a;b']] })

  // VALUES and a WITH ending in SELECT are row-shaped too.
  expect(await engine.dbQuery(projectId, 'values (1, 2), (3, 4)')).toMatchObject({ rows: [['1', '2'], ['3', '4']] })
  expect(await engine.dbQuery(projectId, 'with w as (select 5 as n) select * from w')).toMatchObject({ columns: ['n'], rows: [['5']] })

  // Commands report psql's tag; a WITH ending in DML routes there and actually runs.
  expect(await engine.dbQuery(projectId, 'create table t (a int)')).toMatchObject({ status: expect.stringContaining('CREATE') })
  expect(await engine.dbQuery(projectId, "insert into t values (1), (2)")).toMatchObject({ status: expect.stringContaining('INSERT') })
  expect(await engine.dbQuery(projectId, 'with d as (select 1) update t set a = a')).toMatchObject({ status: expect.stringContaining('UPDATE') })
  // Depth-aware routing: a nested SELECT after the top-level UPDATE still runs the UPDATE.
  expect(await engine.dbQuery(projectId, 'with c as (select 1) update t set a = (select 2)')).toMatchObject({ status: expect.stringContaining('UPDATE') })
  // Several statements are refused before anything executes (one statement per request).
  await expect(engine.dbQuery(projectId, 'select 1; select 2')).rejects.toThrow(/one statement per request/)
  // Parenthesized query expressions wrap, bare and after a WITH.
  expect(await engine.dbQuery(projectId, '(select 1 as n)')).toMatchObject({ columns: ['n'], rows: [['1']] })
  expect(await engine.dbQuery(projectId, 'with x as (select 7 as n) (select * from x)')).toMatchObject({ rows: [['7']] })
  // psql meta-commands are refused (over stdin they would execute); one in a literal is data.
  await expect(engine.dbQuery(projectId, 'select 1 \\watch 1')).rejects.toThrow(/meta-commands/)
  // Two buffers separated by \g carry no semicolon; the refusal must execute NOTHING — the
  // first buffer is side-effecting, and its effect must be absent afterwards.
  await expect(engine.dbQuery(projectId, 'insert into t values (99) \\g select 1 \\g')).rejects.toThrow(/meta-commands/)
  expect(await engine.dbQuery(projectId, 'select count(*) as n from t where a = 99')).toMatchObject({ rows: [['0']] })
  await expect(engine.dbQuery(projectId, "select 1 \\! echo pwned")).rejects.toThrow(/meta-commands/)
  // The E-string mask bypass (round 7): a \! hidden after an identifier-e'...' must NOT execute.
  await expect(engine.dbQuery(projectId, "select 1 where 'x' like'z\\' \\! id")).rejects.toThrow(/meta-commands/)
  // A terminal semicolon shadowed by a trailing comment still answers rows.
  expect(await engine.dbQuery(projectId, 'select 41 as n; -- done')).toMatchObject({ columns: ['n'], rows: [['41']] })
  expect(await engine.dbQuery(projectId, 'select 42 as n; /* done */')).toMatchObject({ rows: [['42']] })
  expect(await engine.dbQuery(projectId, "select 'not a \\watch' as v")).toMatchObject({ rows: [['not a \\watch']] })
  expect(await engine.dbQuery(projectId, 'table t')).toMatchObject({ rowCount: 2 })

  // The statement timeout is real: pg_sleep past the bound cancels instead of holding the exec.
  const started = Date.now()
  await expect(engine.dbQuery(projectId, 'select pg_sleep(60)')).rejects.toThrow(/statement timeout/)
  expect(Date.now() - started).toBeLessThan(45_000)
}, 240_000)
