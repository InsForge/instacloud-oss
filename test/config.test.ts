// src/config.ts: defaults per mode, precedence, validation, host classification (contract 00 §3).
import { test, expect } from 'vitest'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, isDaemonHost, CONFIG_KEYS } from '../src/config'
import { suppliedFiles } from '../src/router/certs'

const tmp = () => mkdtempSync(join(tmpdir(), 'io-cfg-'))

test('a supplied certificate is the PAIR: half of one is refused, naming the missing half', () => {
  // With only the certificate set, the router served no supplied certificate and went on
  // issuing per hostname, while `/healthz` reported a supplied certificate: the endpoint
  // asserted the exact property the box was not providing, in the field an operator would use
  // to confirm it. The installer refuses this combination; a hand-edited `instad.env` does not
  // go through the installer, so it is refused here too, at boot, with the missing key named.
  expect(() => loadConfig({ INSTA_OSS_TLS_CERT_FILE: '/etc/tls/full.pem' }, []))
    .toThrow(/INSTA_OSS_TLS_KEY_FILE is required when the other is set/)
  expect(() => loadConfig({ INSTA_OSS_TLS_KEY_FILE: '/etc/tls/key.pem' }, []))
    .toThrow(/INSTA_OSS_TLS_CERT_FILE is required when the other is set/)
  // ...and as the same KIND of error as every other refusal in `loadConfig`. `ConfigError` is
  // not exported, so this asserts what a caller discriminating on it would see: a bad
  // configuration, not an unexpected crash from somewhere in the loader.
  const kinds = ['INSTA_OSS_TLS_CERT_FILE', 'INSTA_OSS_MODE'].map((k) => {
    try { loadConfig({ [k]: k.endsWith('FILE') ? '/etc/tls/full.pem' : 'nonsense' }, []); return 'no throw' } catch (e) { return (e as Error).constructor.name }
  })
  expect(kinds[0]).toBe(kinds[1])

  // Both halves load, and neither half is not a supplied certificate at all.
  const both = loadConfig({ INSTA_OSS_TLS_CERT_FILE: '/etc/tls/full.pem', INSTA_OSS_TLS_KEY_FILE: '/etc/tls/key.pem' }, [])
  expect(both.tls).toMatchObject({ certFile: '/etc/tls/full.pem', keyFile: '/etc/tls/key.pem' })
  expect(suppliedFiles(both)).toEqual({ crt: '/etc/tls/full.pem', key: '/etc/tls/key.pem' })
  const neither = loadConfig({}, [])
  expect(neither.tls).toMatchObject({ certFile: null, keyFile: null })
  expect(suppliedFiles(neither)).toBeNull()
})

test('local defaults: 127.0.0.1:8080, ~/.insta-oss, no auth, localhost domain, scheduler on', () => {
  const cfg = loadConfig({}, [])
  expect(cfg.mode).toBe('local')
  expect(cfg.listenHost).toBe('127.0.0.1')
  expect(cfg.port).toBe(8080)
  expect(cfg.dataDir).toBe(join(homedir(), '.insta-oss'))
  expect(cfg.statePath).toBe(join(homedir(), '.insta-oss', 'state.json'))
  expect(cfg.garageConfigPath).toBe(join(homedir(), '.insta-oss', 'garage.toml'))
  expect(cfg.s3HostEndpoint).toBe('http://127.0.0.1:3900')
  expect(cfg.domain).toBe('localhost')
  expect(cfg.apiUrl).toBe('http://127.0.0.1:8080')
  expect(cfg.consoleUrl).toBe(cfg.apiUrl)
  expect(cfg.publicIp).toBeNull()
  expect(cfg.trustProxy).toBe(false)
  expect(cfg.auth).toMatchObject({ enabled: false, secret: '', sessionTtlSec: 604800, sessionUpdateAgeSec: 86400, cookieSecure: false, cookieName: 'better-auth.session_token' })
  expect(cfg.lanes).toEqual({ bind: '127.0.0.1', pgPort: 5432, redisPort: 6379, mongoPort: 27017, portRange: [20000, 20999], idleSec: 900, probeWindowMs: 8000, readyWindowMs: 30000, touchDebounceMs: 5000 })
  // No supplied certificate unless `--tls custom` set one: local mode terminates no TLS.
  expect(cfg.tls).toEqual({ certDir: null, edgePort: 443, certFile: null, keyFile: null })
  expect(cfg.sleep).toEqual({ enabled: true, idleComputeSec: 300, idleDbSec: 600, sweepSec: 30, createGraceSec: 600, stopGraceSec: 10, stopGraceDbSec: 30, wakeTimeoutSec: 60, wakeProtectSec: 60, ramFloorPct: 15, memBudgetMb: null, alwaysOnDefault: true })
  expect(cfg.data).toEqual({ helperImage: 'node:22-alpine', fork: 'auto', migrate: true, sweepOrphans: false })
  expect(cfg.services).toEqual({ maxPerType: 5 })
  expect(cfg.templates).toEqual({ volumeGib: 10, healthTimeoutMs: 90000, healthPollMs: 3000 })
  expect(cfg.extraListenHosts).toEqual([])
  expect(cfg.version).toBe(JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version)
  expect(Object.isFrozen(cfg)).toBe(true)
  expect(Object.isFrozen(cfg.sleep)).toBe(true)
})

test('server defaults derive from the domain: URLs, s3 endpoint, cert dir, auth on, lanes on 0.0.0.0', () => {
  const dir = tmp()
  const cfg = loadConfig({ INSTA_OSS_MODE: 'server', INSTA_OSS_DOMAIN: 'Box.Example.Test', INSTA_OSS_DATA_DIR: dir, INSTA_OSS_SECRET: 'x'.repeat(40) }, [])
  expect(cfg.domain).toBe('box.example.test') // lowercased
  expect(cfg.apiUrl).toBe('https://api.box.example.test')
  expect(cfg.consoleUrl).toBe('https://console.box.example.test')
  expect(cfg.s3HostEndpoint).toBe('https://s3.box.example.test')
  expect(cfg.garageConfigPath).toBe(join(dir, 'garage', 'garage.toml'))
  expect(cfg.tls.certDir).toBe(join(dir, 'caddy', 'data', 'caddy', 'certificates'))
  expect(cfg.trustProxy).toBe(true)
  expect(cfg.lanes.bind).toBe('0.0.0.0')
  expect(cfg.auth).toMatchObject({ enabled: true, secret: 'x'.repeat(40), cookieSecure: true, cookieName: '__Secure-better-auth.session_token' })
  expect(cfg.listenHost).toBe('127.0.0.1') // both modes bind loopback; the edge is the only remote client
})

test('server mode without INSTA_OSS_DOMAIN throws; a malformed domain throws', () => {
  expect(() => loadConfig({ INSTA_OSS_MODE: 'server', INSTA_OSS_DATA_DIR: tmp(), INSTA_OSS_AUTH: '0' }, [])).toThrow(/INSTA_OSS_DOMAIN is required/)
  expect(() => loadConfig({ INSTA_OSS_MODE: 'server', INSTA_OSS_DOMAIN: 'bad_domain!', INSTA_OSS_DATA_DIR: tmp(), INSTA_OSS_AUTH: '0' }, [])).toThrow(/INSTA_OSS_DOMAIN must match/)
  expect(() => loadConfig({ INSTA_OSS_MODE: 'cloud' }, [])).toThrow(/INSTA_OSS_MODE/)
})

test('server mode mints <dataDir>/secret (0600) when INSTA_OSS_SECRET is unset, and reuses it', () => {
  const dir = tmp()
  const a = loadConfig({ INSTA_OSS_MODE: 'server', INSTA_OSS_DOMAIN: 'x.test', INSTA_OSS_DATA_DIR: dir }, [])
  expect(a.auth.secret.length).toBeGreaterThanOrEqual(32)
  expect(readFileSync(join(dir, 'secret'), 'utf8').trim()).toBe(a.auth.secret)
  expect(statSync(join(dir, 'secret')).mode & 0o777).toBe(0o600)
  const b = loadConfig({ INSTA_OSS_MODE: 'server', INSTA_OSS_DOMAIN: 'x.test', INSTA_OSS_DATA_DIR: dir }, [])
  expect(b.auth.secret).toBe(a.auth.secret)
  // a short explicit secret is refused; auth off needs no secret at all
  expect(() => loadConfig({ INSTA_OSS_MODE: 'server', INSTA_OSS_DOMAIN: 'x.test', INSTA_OSS_DATA_DIR: dir, INSTA_OSS_SECRET: 'short' }, [])).toThrow(/at least 32/)
  expect(loadConfig({ INSTA_OSS_MODE: 'server', INSTA_OSS_DOMAIN: 'x.test', INSTA_OSS_DATA_DIR: tmp(), INSTA_OSS_AUTH: '0' }, []).auth).toMatchObject({ enabled: false, secret: '' })
})

test('port precedence: INSTA_OSS_PORT > --port > 8080; the local apiUrl follows it', () => {
  expect(loadConfig({}, ['node', 'main.ts']).port).toBe(8080)
  expect(loadConfig({}, ['node', 'main.ts', '--port', '9000']).port).toBe(9000)
  const both = loadConfig({ INSTA_OSS_PORT: '9100' }, ['node', 'main.ts', '--port', '9000'])
  expect(both.port).toBe(9100)
  expect(both.apiUrl).toBe('http://127.0.0.1:9100')
  expect(() => loadConfig({ INSTA_OSS_PORT: '70000' }, [])).toThrow(/INSTA_OSS_PORT/)
  expect(() => loadConfig({}, ['--port', 'abc'])).toThrow(/--port/)
})

test('bool() and int() validation: 1|true|0|false; integers within range; port ranges', () => {
  expect(loadConfig({ INSTA_OSS_SCHEDULER: '0' }, []).sleep.enabled).toBe(false)
  expect(loadConfig({ INSTA_OSS_SCHEDULER: 'false' }, []).sleep.enabled).toBe(false)
  expect(loadConfig({ INSTA_OSS_SCHEDULER: 'TRUE' }, []).sleep.enabled).toBe(true)
  expect(() => loadConfig({ INSTA_OSS_SCHEDULER: 'yes' }, [])).toThrow(/INSTA_OSS_SCHEDULER must be 1\|true\|0\|false/)
  expect(loadConfig({ INSTA_OSS_IDLE_COMPUTE_SEC: '0' }, []).sleep.idleComputeSec).toBe(0)
  expect(() => loadConfig({ INSTA_OSS_IDLE_COMPUTE_SEC: '1.5' }, [])).toThrow(/INSTA_OSS_IDLE_COMPUTE_SEC must be an integer/)
  expect(() => loadConfig({ INSTA_OSS_RAM_FLOOR_PCT: '95' }, [])).toThrow(/0\.\.90/)
  // 0 is legal and is the documented off switch for memory-pressure eviction (decision 12).
  expect(loadConfig({ INSTA_OSS_RAM_FLOOR_PCT: '0' }, []).sleep.ramFloorPct).toBe(0)
  expect(loadConfig({ INSTA_OSS_MEM_BUDGET_MB: '2048' }, []).sleep.memBudgetMb).toBe(2048)
  expect(loadConfig({ INSTA_OSS_LANE_PORT_RANGE: '30000-30010' }, []).lanes.portRange).toEqual([30000, 30010])
  expect(() => loadConfig({ INSTA_OSS_LANE_PORT_RANGE: '30010-30000' }, [])).toThrow(/INSTA_OSS_LANE_PORT_RANGE/)
  expect(() => loadConfig({ INSTA_OSS_FORK: 'rsync' }, [])).toThrow(/INSTA_OSS_FORK/)
  expect(loadConfig({ INSTA_OSS_FORK: 'basebackup' }, []).data.fork).toBe('basebackup')
  // unknown INSTA_OSS_* keys are ignored
  expect(() => loadConfig({ INSTA_OSS_ROUTER_PORT: '1' }, [])).not.toThrow()
})

test('isDaemonHost: local mode accepts loopback names, IP literals, host.docker.internal and the bridge gateway, with or without a port', () => {
  const cfg = loadConfig({}, [])
  for (const h of ['127.0.0.1', '127.0.0.1:8080', 'localhost', 'localhost:8080', 'LOCALHOST', '[::1]', '[::1]:8080', 'host.docker.internal:8080', '192.168.1.20:8080', 'api.localhost', 'api.localhost:8080', 'localhost.']) {
    expect(isDaemonHost(cfg, h), h).toBe('api')
  }
  expect(isDaemonHost(cfg, 'console.localhost:8080')).toBe('console')
  expect(isDaemonHost(cfg, 'web-demo-main.localhost:8080')).toBeNull() // a minted route host, never the API
  expect(isDaemonHost(cfg, undefined)).toBeNull()
  expect(isDaemonHost(cfg, '')).toBeNull()
  const withGateway = { ...cfg, extraListenHosts: ['172.17.0.1'] }
  expect(isDaemonHost(withGateway, '172.17.0.1:8080')).toBe('api')
})

test('isDaemonHost: server mode is strict (api./console.<domain> only)', () => {
  const cfg = loadConfig({ INSTA_OSS_MODE: 'server', INSTA_OSS_DOMAIN: 'box.test', INSTA_OSS_DATA_DIR: tmp(), INSTA_OSS_AUTH: '0' }, [])
  expect(isDaemonHost(cfg, 'api.box.test')).toBe('api')
  expect(isDaemonHost(cfg, 'API.box.test:443')).toBe('api')
  expect(isDaemonHost(cfg, 'console.box.test')).toBe('console')
  for (const h of ['127.0.0.1:8080', 'localhost', 'box.test', 'web-demo-main.box.test', '1.2.3.4']) expect(isDaemonHost(cfg, h), h).toBeNull()
})

test('CONFIG_KEYS names every key loadConfig reads (the installer test asserts install.sh writes each)', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'config.ts'), 'utf8')
  const read = new Set([...src.matchAll(/'(INSTA_OSS_[A-Z0-9_]+)'/g)].map((m) => m[1]))
  for (const k of read) expect(CONFIG_KEYS, k).toContain(k)
  expect(new Set(CONFIG_KEYS).size).toBe(CONFIG_KEYS.length)
})

test('the session knobs and the cookie name follow the console scheme (WP1)', () => {
  const base = { INSTA_OSS_MODE: 'server', INSTA_OSS_DOMAIN: 'x.test', INSTA_OSS_SECRET: 'y'.repeat(32) }
  const secure = loadConfig({ ...base, INSTA_OSS_DATA_DIR: tmp() }, [])
  expect(secure.auth.sessionTtlSec).toBe(604800)
  expect(secure.auth.sessionUpdateAgeSec).toBe(86400)
  const plain = loadConfig({ ...base, INSTA_OSS_DATA_DIR: tmp(), INSTA_OSS_CONSOLE_URL: 'http://box.lan:8080', INSTA_OSS_SESSION_TTL_SEC: '3600' }, [])
  expect(plain.auth.cookieSecure).toBe(false)
  expect(plain.auth.cookieName).toBe('better-auth.session_token')
  expect(plain.auth.sessionTtlSec).toBe(3600)
})

test('extraListenHosts is filled by main.ts, never by loadConfig (WP1)', () => {
  expect(loadConfig({ INSTA_OSS_DATA_DIR: tmp() }, []).extraListenHosts).toEqual([])
})

// The vitest config's own invariant, because it is the only thing standing between CI and two
// Docker suites racing over `io-garage`, dockerd's address pool and the default state file. It
// reads `RUN_DOCKER_TESTS` at module load, so this assertion holds in BOTH runs: parallel files
// for the fake-adapter suites, one file at a time as soon as containers are in play.
test('RUN_DOCKER_TESTS turns file parallelism off, so the container suites run one at a time', async () => {
  const cfg = (await import('../vitest.config')).default as { test?: { fileParallelism?: boolean } }
  expect(cfg.test?.fileParallelism).toBe(!process.env.RUN_DOCKER_TESTS)
})
