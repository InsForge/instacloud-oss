// Integration (real Docker, integrator only: RUN_DOCKER_TESTS=1): the files install.sh writes are a
// valid compose stack. The three renderers (--print-env, --print-compose, --print-caddyfile) go into a
// tmp directory exactly as step 7 of the installer lays them out, then `docker compose config` resolves
// the interpolation and normalises the stack, and `caddy validate` parses the edge config. Nothing is
// ever brought `up`: no container of this suite outlives it and no name can collide with another
// implementer's stack (plan 06 "Tests"; contract decision 44).
import { test, expect, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const SCRIPT = join(ROOT, 'install.sh')
// realpath: on macOS the tmp dir is a symlink under /var, and compose resolves relative binds itself
const CFG = realpathSync(mkdtempSync(join(tmpdir(), 'io-compose-')))
const DATA = join(CFG, 'data')
const DOMAIN = 'compose.test'
const VERSION = '9.9.9-test'

// The environment install.sh runs with, minus anything of the developer's own (every INSTA_OSS_* it
// sees is passed through into instad.env).
const env = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  INSTA_OSS_DOMAIN: DOMAIN,
  INSTA_OSS_DATA_DIR: DATA,
  INSTA_OSS_VERSION: VERSION,
  INSTA_OSS_SECRET: 'a'.repeat(64),
  INSTA_OSS_ACME_EMAIL: 'ops@compose.test',
}
const render = (mode: string, extra: Record<string, string> = {}): string =>
  execFileSync('sh', [SCRIPT, `--print-${mode}`], { env: { ...env, ...extra }, encoding: 'utf8' })

writeFileSync(join(CFG, 'instad.env'), render('env'), { mode: 0o600 })
writeFileSync(join(CFG, 'compose.yml'), render('compose'))
writeFileSync(join(CFG, 'Caddyfile'), render('caddyfile'))

const compose = (...args: string[]): ReturnType<typeof spawnSync> =>
  spawnSync('docker', ['compose', '--env-file', 'instad.env', '-f', 'compose.yml', ...args], { cwd: CFG, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

afterAll(() => { try { rmSync(CFG, { recursive: true, force: true }) } catch { /* best-effort */ } })

interface ComposeVolume { type: string; source: string; target: string; read_only?: boolean }
interface ComposePort { published?: string | number; target?: number; host_ip?: string }
interface ComposeService {
  image?: string
  container_name?: string
  network_mode?: string
  restart?: string
  init?: boolean
  stop_grace_period?: string
  volumes?: ComposeVolume[]
  ports?: ComposePort[]
  environment?: Record<string, string | null>
}
interface ComposeFile { name?: string; services: Record<string, ComposeService> }

test('docker compose config resolves the rendered stack: host networking, the socket and the identical-path data bind', () => {
  const r = compose('config')
  expect(String(r.stderr)).not.toMatch(/variable is not set|error/i)   // an unset INSTA_OSS_* would blank a bind
  expect(r.status).toBe(0)
  expect(String(r.stdout)).toContain('network_mode: host')
  // `compose config` normalises every bind to the long form, so the pair is two lines here; the
  // json pass below pins source and target together on instad's own volume list.
  expect(String(r.stdout)).toContain(`source: ${DATA}`)
  expect(String(r.stdout)).toContain(`target: ${DATA}`)

  const json = compose('config', '--format', 'json')
  expect(json.status).toBe(0)
  const cfg = JSON.parse(String(json.stdout)) as ComposeFile
  expect(cfg.name).toBe('instacloud')
  expect(Object.keys(cfg.services).sort()).toEqual(['edge', 'garage', 'instad'])

  const instad = cfg.services.instad
  expect(instad.image).toBe(`ghcr.io/insforge/instacloud:${VERSION}`)
  expect(instad.container_name).toBe('io-instad')
  expect(instad.network_mode).toBe('host')
  expect(instad.restart).toBe('unless-stopped')
  expect(instad.init).toBe(true)
  expect(instad.stop_grace_period).toBe('30s')
  expect(instad.ports ?? []).toEqual([])                       // host network: publishing is meaningless
  const binds = (instad.volumes ?? []).map((v) => `${v.source}:${v.target}`)
  expect(binds).toContain('/var/run/docker.sock:/var/run/docker.sock')
  expect(binds).toContain(`${DATA}:${DATA}`)                   // identical path: every bind the daemon emits is host-valid
  // env_file was read: the daemon's own keys arrive through it, not through `environment`
  expect(instad.environment?.INSTA_OSS_DOMAIN).toBe(DOMAIN)
  expect(instad.environment?.INSTA_OSS_MODE).toBe('server')
  expect(instad.environment?.INSTA_OSS_DATA_DIR).toBe(DATA)

  const edge = cfg.services.edge
  expect(edge.container_name).toBe('io-edge')
  expect(edge.network_mode).toBe('host')
  expect(edge.image).toMatch(/^caddy:2\./)
  const edgeBinds = (edge.volumes ?? []).map((v) => `${v.source}:${v.target}`)
  expect(edgeBinds).toContain(`${join(CFG, 'Caddyfile')}:/etc/caddy/Caddyfile`)
  expect(edgeBinds).toContain(`${DATA}/caddy/data:/data`)
  expect((edge.volumes ?? []).find((v) => v.target === '/etc/caddy/Caddyfile')?.read_only).toBe(true)

  const garage = cfg.services.garage
  expect(garage.container_name).toBe('io-garage')
  expect(garage.network_mode).toBeUndefined()                  // stays on the bridge for branch networks
  const pub = (garage.ports ?? []).map((p) => `${p.host_ip ?? ''}:${p.published ?? ''}->${p.target ?? ''}`)
  expect(pub).toEqual(['127.0.0.1:3900->3900', '127.0.0.1:3902->3902'])
  const garageBinds = (garage.volumes ?? []).map((v) => `${v.source}:${v.target}`)
  expect(garageBinds).toContain(`${DATA}/garage/garage.toml:/etc/garage.toml`)
  expect(garageBinds).toContain(`${DATA}/garage/meta:/var/lib/garage/meta`)
  expect(garageBinds).toContain(`${DATA}/garage/data:/var/lib/garage/data`)
}, 120_000)

test('caddy validate parses the rendered Caddyfile (both TLS modes)', () => {
  const image = (readFileSync(join(CFG, 'compose.yml'), 'utf8').match(/image: (caddy:\S+)/) ?? [])[1]
  expect(image).toBeDefined()
  for (const tls of ['acme', 'internal']) {
    const file = join(CFG, `Caddyfile.${tls}`)
    writeFileSync(file, render('caddyfile', { INSTA_OSS_TLS: tls }))
    const r = spawnSync('docker', ['run', '--rm', '-v', `${file}:/etc/caddy/Caddyfile:ro`, String(image),
      'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], { encoding: 'utf8' })
    expect(`${tls}: ${String(r.stdout)}${String(r.stderr)}`).toMatch(/Valid configuration/)
    expect(r.status).toBe(0)
  }
}, 180_000)
