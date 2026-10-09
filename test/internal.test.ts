// The loopback listener the edge consults before issuing a certificate (decision 22). It is NOT a
// Fastify route: nothing outside the box can reach it, and nothing inside the API surface should be
// able to answer it either, so the last test pins that `/tls/ask` is unknown to the API.
import { test, expect, beforeEach, afterEach } from 'vitest'
import { createServer } from 'node:http'
import { buildServer } from '../src/server'
import { makeEngine, resetFakes, serverConfig, testConfig } from './fakes'
import { createInternalServer } from '../src/router/internal'
import type { Engine } from '../src/engine'
import type { Config } from '../src/config'

let engine: Engine
let cfg: Config
let server: ReturnType<typeof createServer>
let base: string

const listen = (s: ReturnType<typeof createServer>): Promise<number> =>
  new Promise((resolve) => s.listen(0, '127.0.0.1', () => {
    const a = s.address()
    resolve(typeof a === 'object' && a ? a.port : 0)
  }))

beforeEach(async () => {
  resetFakes()
  cfg = serverConfig()
  engine = makeEngine(cfg)
  server = createInternalServer({ ownsHostname: (h) => engine.ownsHostname(h), log: () => { /* quiet */ } })
  base = `http://127.0.0.1:${await listen(server)}`
})

afterEach(() => { server.close() })

const ask = async (domain: string): Promise<{ status: number; body: string }> => {
  const r = await fetch(`${base}/tls/ask?domain=${encodeURIComponent(domain)}`)
  return { status: r.status, body: await r.text() }
}

test('the ask endpoint answers 200 for every hostname this daemon serves and 404 for the rest', async () => {
  const { project } = await engine.createProject('demo')
  // Project create provisions nothing (WP5): the pair whose hostnames this test asks about is
  // added the way the CLI adds it.
  await engine.addDbService(project.id, 'db')
  await engine.addStorageService(project.id, 'store')
  await engine.deploy(project.id, 'main', { image: 'nginx', port: 80 })
  await engine.addManagedService(project.id, 'redis', 'cache')

  // Minted service names.
  expect((await ask('default-demo-main.example.test')).status).toBe(200)
  expect((await ask('default-demo-main.example.test')).body).toBe('ok')
  expect((await ask('pg-db-demo-main.example.test')).status).toBe(200)
  expect((await ask('redis-cache-demo-main.example.test')).status).toBe(200)
  // The daemon's own names and the object store.
  expect((await ask('api.example.test')).status).toBe(200)
  expect((await ask('console.example.test')).status).toBe(200)
  expect((await ask('s3.example.test')).status).toBe(200)
  // An existing bucket's vhost, but not a bucket nobody created.
  expect((await ask('io-demo-main-store.s3.example.test')).status).toBe(200)
  expect((await ask('not-a-bucket.s3.example.test')).status).toBe(404)
  // Someone else's name.
  expect((await ask('evil.example.com')).status).toBe(404)
  expect((await ask('example.test')).status).toBe(404)
})

test('an attached custom domain is answered 200 and a detached one goes back to 404', async () => {
  const { project } = await engine.createProject('demo')
  await engine.deploy(project.id, 'main', { image: 'nginx', port: 80 })

  expect((await ask('app.example.com')).status).toBe(404)
  await engine.setComputeDomain(project.id, { hostname: 'app.example.com' })
  expect((await ask('app.example.com')).status).toBe(200)
  // Case and a trailing dot are normalized, as Caddy may send either.
  expect((await ask('APP.example.com.')).status).toBe(200)

  engine.removeComputeDomain(project.id, { hostname: 'app.example.com' })
  expect((await ask('app.example.com')).status).toBe(404)
})

test('malformed and missing domains are 400, healthz is 200, everything else is 404', async () => {
  expect((await ask('')).status).toBe(400)
  expect((await ask('has space')).status).toBe(400)
  expect((await ask('a/b')).status).toBe(400)
  expect((await fetch(`${base}/tls/ask`)).status).toBe(400)

  const health = await fetch(`${base}/healthz`)
  expect(health.status).toBe(200)
  expect(await health.json()).toEqual({ ok: true })

  expect((await fetch(`${base}/`)).status).toBe(404)
  expect((await fetch(`${base}/projects`)).status).toBe(404)
  expect((await fetch(`${base}/tls/ask`, { method: 'POST' })).status).toBe(404)
})

test('/tls/ask is not an API route: the daemon never answers it', async () => {
  // Local mode has no guard, so the answer is the bare truth: there is no such route.
  const local = buildServer(makeEngine(testConfig()))
  expect((await local.inject({ method: 'GET', url: '/tls/ask?domain=api.example.test' })).statusCode).toBe(404)
  await local.close()
  // Server mode keeps `/tls` inside API_PREFIXES (WP1's allowlist line), so an anonymous caller is
  // refused by the identity guard before routing and never gets the dashboard shell either.
  const app = buildServer(makeEngine(cfg), cfg)
  const r = await app.inject({ method: 'GET', url: '/tls/ask?domain=api.example.test' })
  expect(r.statusCode).toBe(401)
  await app.close()
})
