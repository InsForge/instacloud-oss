// Run-mode configuration (contract 00 section 3). One frozen Config is loaded at boot and INJECTED
// (buildServer(engine, cfg), new Engine(..., { cfg })); there is no module-level singleton, so
// tests build distinct configs per case. Every knob is INSTA_OSS_*; durations are _SEC integers
// except the sub-second router windows (_MS). Unknown INSTA_OSS_* keys are ignored.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export type RunMode = 'local' | 'server'
export type ForkMode = 'auto' | 'reflink' | 'basebackup'

export interface Config {
  mode: RunMode
  version: string                 // INSTA_OSS_VERSION | package.json version
  listenHost: string              // INSTA_OSS_LISTEN_HOST      127.0.0.1 (both modes)
  extraListenHosts: string[]      // local + linux: [docker bridge gateway ip]; else []  (resolved by main.ts, not loadConfig)
  port: number                    // INSTA_OSS_PORT | --port    8080
  dataDir: string                 // INSTA_OSS_DATA_DIR         local ~/.insta-oss | server /var/lib/instacloud (absolute HOST path)
  statePath: string               // INSTA_OSS_STATE            <dataDir>/state.json
  garageConfigPath: string        // INSTA_OSS_GARAGE_CONFIG    local <dataDir>/garage.toml | server <dataDir>/garage/garage.toml
  s3HostEndpoint: string          // INSTA_OSS_S3_HOST_ENDPOINT local http://127.0.0.1:3900 | server https://s3.<domain>
  uiDist: string                  // INSTA_OSS_UI_DIST          <repo>/ui/dist
  templatesDir: string            // INSTA_OSS_TEMPLATES_DIR    <repo>/templates
  domain: string                  // INSTA_OSS_DOMAIN           local 'localhost' | server REQUIRED (lowercase, /^[a-z0-9.-]+$/)
  apiUrl: string                  // INSTA_OSS_API_URL          local http://127.0.0.1:<port> | server https://api.<domain>
  consoleUrl: string              // INSTA_OSS_CONSOLE_URL      local = apiUrl | server https://console.<domain>
  publicIp: string | null         // INSTA_OSS_PUBLIC_IP        null (installer writes it; custom-domain hints)
  trustProxy: boolean             // INSTA_OSS_TRUST_PROXY      local false | server true
  internalPort: number            // INSTA_OSS_INTERNAL_PORT    8081 (server only: /tls/ask + /healthz on 127.0.0.1)
  auth: {
    enabled: boolean              // INSTA_OSS_AUTH             local false | server true
    secret: string                // INSTA_OSS_SECRET           else <dataDir>/secret (created, 0600); >= 32 chars; '' when auth disabled
    sessionTtlSec: number         // INSTA_OSS_SESSION_TTL_SEC  604800
    sessionUpdateAgeSec: number   // constant 86400
    cookieSecure: boolean         // derived: consoleUrl starts with https://
    cookieName: string            // derived: (cookieSecure ? '__Secure-' : '') + 'better-auth.session_token'
  }
  lanes: {
    bind: string                  // INSTA_OSS_LANE_BIND        local 127.0.0.1 | server 0.0.0.0
    pgPort: number                // INSTA_OSS_LANE_PG_PORT     5432 (server; local uses portRange)
    redisPort: number             // INSTA_OSS_LANE_REDIS_PORT  6379
    mongoPort: number             // INSTA_OSS_LANE_MONGO_PORT  27017
    portRange: [number, number]   // INSTA_OSS_LANE_PORT_RANGE  '20000-20999' (local-mode DB lanes; server-mode mysql)
    idleSec: number               // INSTA_OSS_LANE_IDLE_SEC    900 (silent TCP connection cut)
    probeWindowMs: number         // INSTA_OSS_PROBE_WINDOW_MS  8000
    readyWindowMs: number         // INSTA_OSS_READY_WINDOW_MS  30000
    touchDebounceMs: number       // INSTA_OSS_TOUCH_DEBOUNCE_MS 5000
  }
  tls: {
    certDir: string | null        // INSTA_OSS_TLS_CERT_DIR     server <dataDir>/caddy/data/caddy/certificates | local null
    edgePort: number              // INSTA_OSS_EDGE_PORT        443 (the router handshakes here to trigger issuance)
    /** A certificate the OPERATOR supplied, covering `*.<domain>` (`--tls custom`). When it is
     *  set, no lane ever asks the edge to issue anything: this pair is served for every SNI, and
     *  a service hostname therefore reaches no certificate transparency log. */
    certFile: string | null       // INSTA_OSS_TLS_CERT_FILE    unset
    keyFile: string | null        // INSTA_OSS_TLS_KEY_FILE     unset
  }
  sleep: {
    enabled: boolean              // INSTA_OSS_SCHEDULER        true (ticker); wake/sleep on demand work regardless
    idleComputeSec: number        // INSTA_OSS_IDLE_COMPUTE_SEC 300 (0 disables the sweep for compute)
    idleDbSec: number             // INSTA_OSS_IDLE_DB_SEC      600 (0 disables for databases)
    sweepSec: number              // INSTA_OSS_SWEEP_SEC        30
    createGraceSec: number        // INSTA_OSS_CREATE_GRACE_SEC 600
    stopGraceSec: number          // INSTA_OSS_STOP_GRACE_SEC   10
    stopGraceDbSec: number        // INSTA_OSS_STOP_GRACE_DB_SEC 30
    wakeTimeoutSec: number        // INSTA_OSS_WAKE_TIMEOUT_SEC 60 (the whole wake as a CALLER sees it: the wait for the key, eviction, the start and readiness, per contract 00 lines 179-188)
    wakeProtectSec: number        // INSTA_OSS_WAKE_PROTECT_SEC 60
    ramFloorPct: number           // INSTA_OSS_RAM_FLOOR_PCT    15 (0..90; 0 disables the pressure pass)
    memBudgetMb: number | null    // INSTA_OSS_MEM_BUDGET_MB    null (synthetic total for tests/e2e; null = /proc/meminfo)
    alwaysOnDefault: boolean      // INSTA_OSS_ALWAYS_ON_DEFAULT true (default branch only; see effectiveAlwaysOn)
  }
  data: {
    helperImage: string           // INSTA_OSS_HELPER_IMAGE     node:22-alpine
    fork: ForkMode                // INSTA_OSS_FORK             auto
    migrate: boolean              // INSTA_OSS_DATA_MIGRATE     true
    sweepOrphans: boolean         // INSTA_OSS_SWEEP_ORPHANS    false (boot deletes data dirs whose ref matches no branch; the installer never sets it, 04 §G)
  }
  services: { maxPerType: number } // INSTA_OSS_MAX_SERVICES_PER_TYPE 5
  templates: {
    volumeGib: number             // INSTA_OSS_TEMPLATE_VOLUME_GIB 10
    healthTimeoutMs: number       // INSTA_OSS_TEMPLATE_HEALTH_TIMEOUT_MS 90000
    healthPollMs: number          // INSTA_OSS_TEMPLATE_HEALTH_POLL_MS 3000
  }
}

/** A supplied certificate is the PAIR or nothing. Half of one is refused rather than ignored:
 *  with only the certificate set, the router would go on issuing per-hostname certificates while
 *  `/healthz` reported a supplied one, so the endpoint would assert the very property the box
 *  was not providing. The installer refuses the same combination; this catches a hand-edited
 *  `instad.env`, at boot, with a legible message rather than at a browser. */
function suppliedPair(certFile: string, keyFile: string): { certFile: string | null; keyFile: string | null } {
  if (certFile && keyFile) return { certFile, keyFile }
  if (certFile || keyFile) {
    const missing = certFile ? 'INSTA_OSS_TLS_KEY_FILE' : 'INSTA_OSS_TLS_CERT_FILE'
    throw new ConfigError(`${missing} is required when the other is set: a supplied certificate is the pair or nothing (see --tls custom)`)
  }
  return { certFile: null, keyFile: null }
}

/** Every INSTA_OSS_* key loadConfig reads (test/install.test.ts asserts install.sh writes each). */
export const CONFIG_KEYS: readonly string[] = [
  'INSTA_OSS_MODE', 'INSTA_OSS_VERSION', 'INSTA_OSS_LISTEN_HOST', 'INSTA_OSS_PORT', 'INSTA_OSS_DATA_DIR', 'INSTA_OSS_STATE',
  'INSTA_OSS_GARAGE_CONFIG', 'INSTA_OSS_S3_HOST_ENDPOINT', 'INSTA_OSS_UI_DIST', 'INSTA_OSS_TEMPLATES_DIR', 'INSTA_OSS_DOMAIN',
  'INSTA_OSS_API_URL', 'INSTA_OSS_CONSOLE_URL', 'INSTA_OSS_PUBLIC_IP', 'INSTA_OSS_TRUST_PROXY', 'INSTA_OSS_INTERNAL_PORT',
  'INSTA_OSS_AUTH', 'INSTA_OSS_SECRET', 'INSTA_OSS_SESSION_TTL_SEC',
  'INSTA_OSS_LANE_BIND', 'INSTA_OSS_LANE_PG_PORT', 'INSTA_OSS_LANE_REDIS_PORT', 'INSTA_OSS_LANE_MONGO_PORT', 'INSTA_OSS_LANE_PORT_RANGE',
  'INSTA_OSS_LANE_IDLE_SEC', 'INSTA_OSS_PROBE_WINDOW_MS', 'INSTA_OSS_READY_WINDOW_MS', 'INSTA_OSS_TOUCH_DEBOUNCE_MS',
  'INSTA_OSS_TLS_CERT_DIR', 'INSTA_OSS_EDGE_PORT', 'INSTA_OSS_TLS_CERT_FILE', 'INSTA_OSS_TLS_KEY_FILE',
  'INSTA_OSS_SCHEDULER', 'INSTA_OSS_IDLE_COMPUTE_SEC', 'INSTA_OSS_IDLE_DB_SEC', 'INSTA_OSS_SWEEP_SEC', 'INSTA_OSS_CREATE_GRACE_SEC',
  'INSTA_OSS_STOP_GRACE_SEC', 'INSTA_OSS_STOP_GRACE_DB_SEC', 'INSTA_OSS_WAKE_TIMEOUT_SEC', 'INSTA_OSS_WAKE_PROTECT_SEC',
  'INSTA_OSS_RAM_FLOOR_PCT', 'INSTA_OSS_MEM_BUDGET_MB', 'INSTA_OSS_ALWAYS_ON_DEFAULT',
  'INSTA_OSS_HELPER_IMAGE', 'INSTA_OSS_FORK', 'INSTA_OSS_DATA_MIGRATE', 'INSTA_OSS_SWEEP_ORPHANS',
  'INSTA_OSS_MAX_SERVICES_PER_TYPE',
  'INSTA_OSS_TEMPLATE_VOLUME_GIB', 'INSTA_OSS_TEMPLATE_HEALTH_TIMEOUT_MS', 'INSTA_OSS_TEMPLATE_HEALTH_POLL_MS',
]

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_VERSION: string = (() => {
  try { return String((JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0') }
  catch { return '0.0.0' }
})()

class ConfigError extends Error {}

/** `1|true|0|false` (case-insensitive); anything else throws. */
function bool(env: NodeJS.ProcessEnv, key: string, def: boolean): boolean {
  const raw = env[key]
  if (raw === undefined || raw === '') return def
  const v = raw.trim().toLowerCase()
  if (v === '1' || v === 'true') return true
  if (v === '0' || v === 'false') return false
  throw new ConfigError(`${key} must be 1|true|0|false (got ${JSON.stringify(raw)})`)
}

/** Integer within [min, max]; anything else throws. */
function intValue(raw: string | undefined, key: string, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined || raw === '') return def
  const n = Number(raw.trim())
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${key} must be an integer in ${min}..${max} (got ${JSON.stringify(raw)})`)
  return n
}
function int(env: NodeJS.ProcessEnv, key: string, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  return intValue(env[key], key, def, min, max)
}

function str(env: NodeJS.ProcessEnv, key: string, def: string): string {
  const raw = env[key]
  return raw === undefined || raw === '' ? def : raw
}

function portRange(env: NodeJS.ProcessEnv, key: string, def: [number, number]): [number, number] {
  const raw = env[key]
  if (raw === undefined || raw === '') return def
  const m = /^(\d+)-(\d+)$/.exec(raw.trim())
  const lo = m ? Number(m[1]) : NaN
  const hi = m ? Number(m[2]) : NaN
  if (!m || lo < 1 || hi > 65535 || lo > hi) throw new ConfigError(`${key} must be '<lo>-<hi>' within 1..65535 with lo <= hi (got ${JSON.stringify(raw)})`)
  return [lo, hi]
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v)
  }
  return o
}

/** Server mode only: INSTA_OSS_SECRET, else <dataDir>/secret (created once, 0600). */
function readOrCreateSecret(dataDir: string): string {
  const p = join(dataDir, 'secret')
  if (existsSync(p)) return readFileSync(p, 'utf8').trim()
  mkdirSync(dataDir, { recursive: true })
  const secret = randomBytes(32).toString('base64url')
  writeFileSync(p, `${secret}\n`, { mode: 0o600 })
  return secret
}

/** Pure over env/argv, except: in server mode with INSTA_OSS_SECRET unset it reads or creates <dataDir>/secret. Throws on invalid values. Never mutates process.env. Returns a frozen object. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): Config {
  const modeRaw = str(env, 'INSTA_OSS_MODE', 'local')
  if (modeRaw !== 'local' && modeRaw !== 'server') throw new ConfigError(`INSTA_OSS_MODE must be local|server (got ${JSON.stringify(modeRaw)})`)
  const mode: RunMode = modeRaw
  const server = mode === 'server'

  // Precedence: INSTA_OSS_PORT, then --port <n>, then 8080 (today's main.ts).
  const portFlag = argv.indexOf('--port')
  const portFromArgv = intValue(portFlag === -1 ? undefined : argv[portFlag + 1], '--port', 8080, 1, 65535)
  const port = int(env, 'INSTA_OSS_PORT', portFromArgv, 1, 65535)

  const dataDir = resolve(str(env, 'INSTA_OSS_DATA_DIR', server ? '/var/lib/instacloud' : join(homedir(), '.insta-oss')))

  let domain = str(env, 'INSTA_OSS_DOMAIN', server ? '' : 'localhost').trim().toLowerCase().replace(/\.$/, '')
  if (server && !domain) throw new ConfigError('INSTA_OSS_DOMAIN is required in server mode (the installer writes <ip-dashes>.sslip.io)')
  if (!/^[a-z0-9.-]+$/.test(domain)) throw new ConfigError(`INSTA_OSS_DOMAIN must match /^[a-z0-9.-]+$/ (got ${JSON.stringify(domain)})`)
  domain = domain.replace(/\.$/, '')

  const apiUrl = str(env, 'INSTA_OSS_API_URL', server ? `https://api.${domain}` : `http://127.0.0.1:${port}`)
  const consoleUrl = str(env, 'INSTA_OSS_CONSOLE_URL', server ? `https://console.${domain}` : apiUrl)

  const authEnabled = bool(env, 'INSTA_OSS_AUTH', server)
  const secret = authEnabled ? (str(env, 'INSTA_OSS_SECRET', '') || readOrCreateSecret(dataDir)) : ''
  if (authEnabled && secret.length < 32) throw new ConfigError('INSTA_OSS_SECRET must be at least 32 characters')
  const cookieSecure = consoleUrl.startsWith('https://')

  const forkRaw = str(env, 'INSTA_OSS_FORK', 'auto')
  if (forkRaw !== 'auto' && forkRaw !== 'reflink' && forkRaw !== 'basebackup') throw new ConfigError(`INSTA_OSS_FORK must be auto|reflink|basebackup (got ${JSON.stringify(forkRaw)})`)

  const memBudgetRaw = env.INSTA_OSS_MEM_BUDGET_MB
  const memBudgetMb = memBudgetRaw === undefined || memBudgetRaw === '' ? null : int(env, 'INSTA_OSS_MEM_BUDGET_MB', 0, 1)

  const cfg: Config = {
    mode,
    version: str(env, 'INSTA_OSS_VERSION', PKG_VERSION),
    listenHost: str(env, 'INSTA_OSS_LISTEN_HOST', '127.0.0.1'),
    extraListenHosts: [],
    port,
    dataDir,
    statePath: str(env, 'INSTA_OSS_STATE', join(dataDir, 'state.json')),
    garageConfigPath: str(env, 'INSTA_OSS_GARAGE_CONFIG', server ? join(dataDir, 'garage', 'garage.toml') : join(dataDir, 'garage.toml')),
    s3HostEndpoint: str(env, 'INSTA_OSS_S3_HOST_ENDPOINT', server ? `https://s3.${domain}` : 'http://127.0.0.1:3900'),
    uiDist: str(env, 'INSTA_OSS_UI_DIST', join(REPO_ROOT, 'ui', 'dist')),
    templatesDir: str(env, 'INSTA_OSS_TEMPLATES_DIR', join(REPO_ROOT, 'templates')),
    domain,
    apiUrl,
    consoleUrl,
    publicIp: str(env, 'INSTA_OSS_PUBLIC_IP', '') || null,
    trustProxy: bool(env, 'INSTA_OSS_TRUST_PROXY', server),
    internalPort: int(env, 'INSTA_OSS_INTERNAL_PORT', 8081, 1, 65535),
    auth: {
      enabled: authEnabled,
      secret,
      sessionTtlSec: int(env, 'INSTA_OSS_SESSION_TTL_SEC', 604800, 1),
      sessionUpdateAgeSec: 86400,
      cookieSecure,
      cookieName: `${cookieSecure ? '__Secure-' : ''}better-auth.session_token`,
    },
    lanes: {
      bind: str(env, 'INSTA_OSS_LANE_BIND', server ? '0.0.0.0' : '127.0.0.1'),
      pgPort: int(env, 'INSTA_OSS_LANE_PG_PORT', 5432, 1, 65535),
      redisPort: int(env, 'INSTA_OSS_LANE_REDIS_PORT', 6379, 1, 65535),
      mongoPort: int(env, 'INSTA_OSS_LANE_MONGO_PORT', 27017, 1, 65535),
      portRange: portRange(env, 'INSTA_OSS_LANE_PORT_RANGE', [20000, 20999]),
      idleSec: int(env, 'INSTA_OSS_LANE_IDLE_SEC', 900),
      probeWindowMs: int(env, 'INSTA_OSS_PROBE_WINDOW_MS', 8000),
      readyWindowMs: int(env, 'INSTA_OSS_READY_WINDOW_MS', 30000),
      touchDebounceMs: int(env, 'INSTA_OSS_TOUCH_DEBOUNCE_MS', 5000),
    },
    tls: {
      certDir: str(env, 'INSTA_OSS_TLS_CERT_DIR', '') || (server ? join(dataDir, 'caddy', 'data', 'caddy', 'certificates') : null),
      edgePort: int(env, 'INSTA_OSS_EDGE_PORT', 443, 1, 65535),
      ...suppliedPair(str(env, 'INSTA_OSS_TLS_CERT_FILE', ''), str(env, 'INSTA_OSS_TLS_KEY_FILE', '')),
    },
    sleep: {
      enabled: bool(env, 'INSTA_OSS_SCHEDULER', true),
      idleComputeSec: int(env, 'INSTA_OSS_IDLE_COMPUTE_SEC', 300),
      idleDbSec: int(env, 'INSTA_OSS_IDLE_DB_SEC', 600),
      sweepSec: int(env, 'INSTA_OSS_SWEEP_SEC', 30, 1),
      createGraceSec: int(env, 'INSTA_OSS_CREATE_GRACE_SEC', 600),
      stopGraceSec: int(env, 'INSTA_OSS_STOP_GRACE_SEC', 10),
      stopGraceDbSec: int(env, 'INSTA_OSS_STOP_GRACE_DB_SEC', 30),
      wakeTimeoutSec: int(env, 'INSTA_OSS_WAKE_TIMEOUT_SEC', 60, 1),
      wakeProtectSec: int(env, 'INSTA_OSS_WAKE_PROTECT_SEC', 60),
      ramFloorPct: int(env, 'INSTA_OSS_RAM_FLOOR_PCT', 15, 0, 90),
      memBudgetMb,
      // ON, like the hosted platform: on the DEFAULT branch a compute service (and a managed
      // database) stays up unless it is switched to scale-to-zero. Branch clones scale to zero
      // unless a service is explicitly always-on (see `effectiveAlwaysOn`), and Postgres keeps the
      // cloud's own default, scale-to-zero, through its per-branch `scaleToZero` setting.
      alwaysOnDefault: bool(env, 'INSTA_OSS_ALWAYS_ON_DEFAULT', true),
    },
    data: {
      helperImage: str(env, 'INSTA_OSS_HELPER_IMAGE', 'node:22-alpine'),
      fork: forkRaw,
      migrate: bool(env, 'INSTA_OSS_DATA_MIGRATE', true),
      sweepOrphans: bool(env, 'INSTA_OSS_SWEEP_ORPHANS', false),
    },
    services: { maxPerType: int(env, 'INSTA_OSS_MAX_SERVICES_PER_TYPE', 5, 1) },
    templates: {
      volumeGib: int(env, 'INSTA_OSS_TEMPLATE_VOLUME_GIB', 10, 1),
      healthTimeoutMs: int(env, 'INSTA_OSS_TEMPLATE_HEALTH_TIMEOUT_MS', 90000, 1),
      healthPollMs: int(env, 'INSTA_OSS_TEMPLATE_HEALTH_POLL_MS', 3000, 1),
    },
  }
  return deepFreeze(cfg)
}

/** Strip a trailing dot and a :port (IPv6 literals keep their brackets), lowercase. */
function hostOnly(hostHeader: string): string {
  let h = hostHeader.trim().toLowerCase()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    if (end !== -1) h = h.slice(0, end + 1)
  } else {
    const i = h.lastIndexOf(':')
    if (i !== -1 && !h.slice(0, i).includes(':')) h = h.slice(0, i)
  }
  return h.replace(/\.$/, '')
}

/** Which daemon host a Host header names: 'api' for api.<domain> (and, in local mode, 127.0.0.1 / localhost / [::1] / host.docker.internal / the bridge gateway / any IP literal, with or without port), 'console' for console.<domain>, else null. Strips :port and a trailing dot, lowercases. The router's local-mode fallback for a Host that is neither a daemon host nor in the route table is ALSO Fastify (decision 4); isDaemonHost itself stays strict. */
export function isDaemonHost(cfg: Config, hostHeader: string | undefined): 'api' | 'console' | null {
  if (!hostHeader) return null
  const h = hostOnly(hostHeader)
  if (!h) return null
  if (h === `api.${cfg.domain}`) return 'api'
  if (h === `console.${cfg.domain}`) return 'console'
  if (cfg.mode === 'local') {
    if (h === 'localhost' || h === 'host.docker.internal') return 'api'
    if (cfg.extraListenHosts.includes(h)) return 'api'
    const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
    if (isIP(bare)) return 'api'
  }
  return null
}
