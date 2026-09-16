// The backup page's two shell blocks, EXECUTED rather than grepped: a text check cannot tell whether a
// failed mkdir or tar stops the block, so each block runs under `sh` against stub `insta`, `pg_dump`,
// `sudo`, `docker`, `date` and `tar`, with /etc/instacloud and /var/lib/instacloud pointed at temp dirs.
import { test, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const page = readFileSync(join(__dirname, '..', 'docs/self-hosting/upgrade.mdx'), 'utf8')
const blocks = [...page.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1])
const dumpBlock = blocks.find((b) => b.includes('mkdir -m 700 "$B"'))
// Only the subshell: the trailing `insta compute start <group>` line is a placeholder, not a command.
const archiveBlock = blocks.find((b) => b.includes('-czf instacloud-data.tgz.tmp'))?.split('\n)\n')[0].concat('\n)\n')

const STAMP = '20260916-000000'

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'io-backup-doc-'))
  const bin = join(root, 'bin'), etc = join(root, 'etc'), data = join(root, 'data'), work = join(root, 'work')
  for (const d of [bin, etc, data, work]) mkdirSync(d, { recursive: true })
  const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755) }
  const realTar = execFileSync('sh', ['-c', 'command -v tar']).toString().trim()
  stub('insta', 'echo "postgres://stub/$*"')
  stub('pg_dump', 'echo "DUMP $1"')
  stub('sudo', 'exec "$@"')
  stub('date', `echo ${STAMP}`)
  const realId = execFileSync('sh', ['-c', 'command -v id']).toString().trim()
  // Only `id -u` is faked, and only when a case asks: the archive block's root check. `id -g` and the dump block's
  // chown see the real user, so ownership is exercised for real.
  stub('id', `if [ "$1" = -u ] && [ -n "\${FAKE_UID:-}" ]; then echo "$FAKE_UID"; else exec ${realId} "$@"; fi`)
  stub('docker', `echo "docker $*" >> "${root}/docker.log"\nif [ -n "\${FAIL_STOP:-}" ] && [ "$1 $2" = "compose stop" ]; then exit 1; fi\nif [ -n "\${FAIL_PS:-}" ] && [ "$1" = ps ]; then exit 1; fi\nif [ "$1" = ps ] && [ -n "\${BRANCH_IDS:-}" ]; then echo "$BRANCH_IDS"; fi\nif [ -n "\${FAIL_BRANCH_STOP:-}" ] && [ "$1" = stop ]; then exit 1; fi`)
  stub('tar', `if [ -n "\${FAIL_TAR:-}" ]; then echo partial > "$4"; exit 2; fi\nexec ${realTar} "$@"`)
  const run = (block: string, cwd: string, extra: Record<string, string> = {}) => {
    const script = block.replaceAll('/etc/instacloud', etc).replaceAll('/var/lib/instacloud', data)
    try {
      execFileSync('sh', ['-c', script], { cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra }, stdio: 'pipe' })
      return 0
    } catch (e) {
      // A spawn error has no exit status; count it as a failure the case did not intend, never as success.
      const status = (e as { status?: number | null }).status
      return typeof status === 'number' ? status : -1
    }
  }
  return { root, etc, data, work, run }
}

test('the dump block writes every dump, instad.env and both halves of a same-named TLS pair privately', () => {
  expect(dumpBlock, 'the page must carry the dump block').toBeDefined()
  const s = sandbox()
  mkdirSync(join(s.root, 'certs')); mkdirSync(join(s.root, 'keys'))
  writeFileSync(join(s.root, 'certs/tls.pem'), 'CERT'); writeFileSync(join(s.root, 'keys/tls.pem'), 'KEY')
  writeFileSync(join(s.etc, 'instad.env'),
    `INSTA_OSS_TLS=custom\nINSTA_OSS_TLS_CERT_FILE=${join(s.root, 'certs/tls.pem')}\nINSTA_OSS_TLS_KEY_FILE=${join(s.root, 'keys/tls.pem')}\n`)
  expect(s.run(dumpBlock as string, s.work)).toBe(0)
  const B = join(s.work, `backup-${STAMP}`)
  expect(statSync(B).mode & 0o777).toBe(0o700)
  for (const f of ['main.sql', 'feat.sql', 'main-db.sql', 'main-analytics.sql', 'instad.env']) expect(existsSync(join(B, f)), f).toBe(true)
  expect(readFileSync(join(B, 'main-db.sql'), 'utf8')).toContain('--group db --branch main')
  expect(readFileSync(join(B, 'tls-cert.pem'), 'utf8')).toBe('CERT')
  expect(readFileSync(join(B, 'tls-key.pem'), 'utf8')).toBe('KEY')
  expect(statSync(join(B, 'main.sql')).mode & 0o077).toBe(0)

  // The recovery example may only read files this block writes.
  const restores = [...page.matchAll(/< backup-<stamp>\/([\w.-]+)/g)].map((m) => m[1])
  expect(restores.length).toBeGreaterThan(0)
  for (const f of restores) expect(existsSync(join(B, f)), `recovery reads ${f}, which the dump block never writes`).toBe(true)
})

test('the dump block stops, writing nothing, when the backup directory already exists', () => {
  const s = sandbox()
  writeFileSync(join(s.etc, 'instad.env'), 'INSTA_OSS_TLS=acme\n')
  const B = join(s.work, `backup-${STAMP}`)
  mkdirSync(B, { mode: 0o755 }); writeFileSync(join(B, 'main.sql'), 'OLD', { mode: 0o644 })
  expect(s.run(dumpBlock as string, s.work)).toBeGreaterThan(0)
  expect(readFileSync(join(B, 'main.sql'), 'utf8')).toBe('OLD')
  expect(existsSync(join(B, 'instad.env'))).toBe(false)
})

test('the archive block keeps the last good archive when tar fails, and restarts the stack either way', () => {
  expect(archiveBlock, 'the page must carry the archive block').toBeDefined()
  const s = sandbox()
  for (const f of ['state.json']) writeFileSync(join(s.data, f), '{}')
  for (const d of ['pg', 'md', 'vol', 'garage', 'edge', 'caddy']) mkdirSync(join(s.data, d))
  writeFileSync(join(s.etc, 'instacloud-data.tgz'), 'GOOD', { mode: 0o644 })

  // Not root: it refuses before stopping anything, since tar could neither read the data nor write the archive.
  expect(s.run(archiveBlock as string, s.work, { FAKE_UID: '1000' })).toBeGreaterThan(0)
  expect(existsSync(join(s.root, 'docker.log'))).toBe(false)
  expect(readFileSync(join(s.etc, 'instacloud-data.tgz'), 'utf8')).toBe('GOOD')

  expect(s.run(archiveBlock as string, s.work, { FAKE_UID: '0', FAIL_TAR: '1' })).toBeGreaterThan(0)
  expect(readFileSync(join(s.etc, 'instacloud-data.tgz'), 'utf8')).toBe('GOOD')
  expect(existsSync(join(s.etc, 'instacloud-data.tgz.tmp'))).toBe(false)
  expect(readFileSync(join(s.root, 'docker.log'), 'utf8')).toContain('docker compose start')

  // A stop that fails partway (some services already down) still brings the stack back.
  writeFileSync(join(s.root, 'docker.log'), '')
  expect(s.run(archiveBlock as string, s.work, { FAKE_UID: '0', FAIL_STOP: '1' })).toBeGreaterThan(0)
  expect(readFileSync(join(s.root, 'docker.log'), 'utf8')).toMatch(/docker compose stop\ndocker compose start/)
  expect(readFileSync(join(s.etc, 'instacloud-data.tgz'), 'utf8')).toBe('GOOD')

  // A failed branch-container listing must not let tar read files those containers may still be writing.
  writeFileSync(join(s.root, 'docker.log'), '')
  expect(s.run(archiveBlock as string, s.work, { FAKE_UID: '0', FAIL_PS: '1' })).toBeGreaterThan(0)
  expect(readFileSync(join(s.etc, 'instacloud-data.tgz'), 'utf8')).toBe('GOOD')
  expect(readFileSync(join(s.root, 'docker.log'), 'utf8')).toContain('docker compose start')

  // Branch containers are listed and stopped; a stop that fails leaves the good archive alone.
  writeFileSync(join(s.root, 'docker.log'), '')
  expect(s.run(archiveBlock as string, s.work, { FAKE_UID: '0', BRANCH_IDS: 'abc123', FAIL_BRANCH_STOP: '1' })).toBeGreaterThan(0)
  expect(readFileSync(join(s.root, 'docker.log'), 'utf8')).toContain('docker stop abc123')
  expect(readFileSync(join(s.etc, 'instacloud-data.tgz'), 'utf8')).toBe('GOOD')

  writeFileSync(join(s.root, 'docker.log'), '')
  expect(s.run(archiveBlock as string, s.work, { FAKE_UID: '0', BRANCH_IDS: 'abc123' })).toBe(0)
  expect(readFileSync(join(s.root, 'docker.log'), 'utf8')).toMatch(/docker stop abc123[\s\S]*docker compose start/)
  expect(readFileSync(join(s.etc, 'instacloud-data.tgz')).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
  expect(statSync(join(s.etc, 'instacloud-data.tgz')).mode & 0o777).toBe(0o600)
  expect(existsSync(join(s.etc, 'instacloud-data.tgz.tmp'))).toBe(false)
})
