// The backup page's shell blocks, EXECUTED rather than grepped: a text check cannot tell whether a failed
// mkdir or tar stops a block, or whether a restore rebuilds the layout it dumped, so each block runs under
// `sh` against stubs. `insta` is a small stateful daemon: branches and their Postgres services are
// directories and marker files under box/, so a branch create clones its parent's services and a
// `db url` for a service the branch does not carry fails, as on the real daemon.
import { test, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const page = readFileSync(join(__dirname, '..', 'docs/self-hosting/upgrade.mdx'), 'utf8')
const blocks = [...page.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1])
const dumpBlock = blocks.find((b) => b.includes('mkdir -m 700 "$B"'))
const archiveBlock = blocks.find((b) => b.includes('-czf instacloud-data.tgz.tmp'))
const recoveryBlock = blocks.find((b) => b.includes('insta branch create') && b.includes('psql '))

const STAMP = '20260916-000000'

const INSTA_STUB = String.raw`box="$ROOT/box"
echo "insta $*" >> "$ROOT/calls.log"
if [ "$1" = status ]; then cmd=status; shift; else cmd="$1 $2"; shift 2; fi
br=""; g=""; from=""; pos=""
while [ $# -gt 0 ]; do
  case $1 in --branch) br=$2; shift 2 ;; --group) g=$2; shift 2 ;; --from) from=$2; shift 2 ;; --json) shift ;; *) pos="$pos $1"; shift ;; esac
done
def=$(cat "$box/.default" 2>/dev/null || echo main)
case $cmd in
  "project create") set -- $pos; mkdir -p "$box/main"; echo main > "$box/.default"; echo "p-$1 $1" > "$box/.project" ;;
  "status")
    if [ -f "$box/.project" ]; then read -r id nm < "$box/.project"; printf '{"project":{"projectId":"%s","branch":"main"}}\n' "$id"
    else printf '{"project":null}\n'; fi ;;
  "project list")
    if [ -f "$box/.project" ]; then read -r id nm < "$box/.project"; printf '[{"id":"other","name":"other"},{"id":"%s","name":"%s"}]\n' "$id" "$nm"
    else printf '[]\n'; fi ;;
  "branch list")
    printf '['; sep=''
    for d in "$box"/*/; do n=$(basename "$d"); isd=false; [ "$n" = "$def" ] && isd=true
      printf '%s{"name":"%s","is_default":%s}' "$sep" "$n" "$isd"; sep=','; done
    printf ']\n' ;;
  "branch create")
    set -- $pos; n=$1; [ -n "$from" ] || from=$def; p=$box/$from
    [ -d "$box/$n" ] && { echo "branch \"$n\" already exists" >&2; exit 1; }
    [ -z "$(ls "$p")" ] || echo "$n cloned $(ls "$p" | tr '\n' ' ')" >> "$ROOT/clones.log"
    mkdir "$box/$n"; for f in "$p"/*; do [ -e "$f" ] && touch "$box/$n/$(basename "$f")"; done; true ;;
  "services list")
    b=$br; [ -n "$b" ] || b=$def; [ -d "$box/$b" ] || { echo "branch not found: $b" >&2; exit 1; }
    printf '['; sep=''
    for f in "$box/$b"/*; do [ -e "$f" ] || continue; printf '%s{"type":"postgres","name":"%s"}' "$sep" "$(basename "$f")"; sep=','; done
    printf '%s{"type":"compute","name":"web"}]\n' "$sep" ;;
  "services add")
    set -- $pos; b=$br; [ -n "$b" ] || b=$def
    [ -d "$box/$b" ] || { echo "branch not found: $b" >&2; exit 1; }
    [ -e "$box/$b/$2" ] && { echo "service already exists on this branch" >&2; exit 1; }
    touch "$box/$b/$2" ;;
  "db url")
    b=$br; [ -n "$b" ] || b=$def; [ -d "$box/$b" ] || { echo "branch not found: $b" >&2; exit 1; }
    [ -n "$g" ] || { echo "multiple postgres services - specify one" >&2; exit 1; }
    [ -e "$box/$b/$g" ] || { echo "postgres service not found: $g" >&2; exit 1; }
    echo "postgres://stub/$b/$g" ;;
esac`

function sandbox(layout: Record<string, string[]> = { main: ['db'] }, project = 'demo') {
  const root = mkdtempSync(join(tmpdir(), 'io-backup-doc-'))
  const bin = join(root, 'bin'), etc = join(root, 'etc'), data = join(root, 'data'), work = join(root, 'work')
  for (const d of [bin, etc, data, work]) mkdirSync(d, { recursive: true })
  const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755) }
  const which = (cmd: string) => execFileSync('sh', ['-c', `command -v ${cmd}`]).toString().trim()
  stub('insta', INSTA_STUB)
  stub('pg_dump', 'if [ -n "${FAIL_DUMP:-}" ]; then exit 1; fi\necho "DUMP $1"')
  stub('psql', `echo "psql $*" >> "${root}/calls.log"; cat > /dev/null`)
  stub('sudo', 'exec "$@"')
  stub('date', `echo ${STAMP}`)
  // Only `id -u` is faked, and only when a case asks: the archive block's root check. `id -g` and the dump
  // block's chown see the real user, so ownership is exercised for real.
  stub('id', `if [ "$1" = -u ] && [ -n "\${FAKE_UID:-}" ]; then echo "$FAKE_UID"; else exec ${which('id')} "$@"; fi`)
  stub('docker', `echo "docker $*" >> "${root}/docker.log"\nif [ -n "\${FAIL_STOP:-}" ] && [ "$1 $2" = "compose stop" ]; then exit 1; fi\nif [ -n "\${FAIL_PS:-}" ] && [ "$1" = ps ]; then exit 1; fi\nif [ "$1" = ps ] && [ -n "\${BRANCH_IDS:-}" ]; then echo "$BRANCH_IDS"; fi\nif [ -n "\${FAIL_BRANCH_STOP:-}" ] && [ "$1" = stop ]; then exit 1; fi`)
  stub('tar', `if [ -n "\${FAIL_TAR:-}" ]; then echo partial > "$4"; exit 2; fi\nexec ${which('tar')} "$@"`)
  const setBox = (l: Record<string, string[]>) => {
    rmSync(join(root, 'box'), { recursive: true, force: true })
    mkdirSync(join(root, 'box'))
    writeFileSync(join(root, 'box/.default'), 'main\n')
    if (project) writeFileSync(join(root, 'box/.project'), `p-${project} ${project}\n`)
    for (const [branch, services] of Object.entries(l)) {
      mkdirSync(join(root, 'box', branch))
      for (const svc of services) writeFileSync(join(root, 'box', branch, svc), '')
    }
  }
  const box = (): string[] => readdirSync(join(root, 'box'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => { const svcs = readdirSync(join(root, 'box', e.name)); return svcs.length ? svcs.map((svc) => `${e.name}/${svc}`) : [`${e.name}/`] })
    .sort()
  setBox(layout)
  const run = (block: string, cwd: string, extra: Record<string, string> = {}) => {
    const script = block.replaceAll('/etc/instacloud', etc).replaceAll('/var/lib/instacloud', data)
    try {
      execFileSync('sh', ['-c', script], { cwd, env: { ...process.env, ROOT: root, PATH: `${bin}:${process.env.PATH}`, ...extra }, stdio: 'pipe' })
      return 0
    } catch (e) {
      // A spawn error has no exit status; count it as a failure the case did not intend, never as success.
      const status = (e as { status?: number | null }).status
      return typeof status === 'number' ? status : -1
    }
  }
  const log = (name: string) => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : '')
  return { root, etc, data, work, run, setBox, box, log }
}

test('the dump block runs unedited on a default box, secrets private, both halves of a same-named TLS pair kept', () => {
  expect(dumpBlock, 'the page must carry the dump block').toBeDefined()
  const s = sandbox()
  mkdirSync(join(s.root, 'certs')); mkdirSync(join(s.root, 'keys'))
  writeFileSync(join(s.root, 'certs/tls.pem'), 'CERT'); writeFileSync(join(s.root, 'keys/tls.pem'), 'KEY')
  writeFileSync(join(s.etc, 'instad.env'),
    `INSTA_OSS_TLS=custom\nINSTA_OSS_TLS_CERT_FILE=${join(s.root, 'certs/tls.pem')}\nINSTA_OSS_TLS_KEY_FILE=${join(s.root, 'keys/tls.pem')}\n`)
  expect(s.run(dumpBlock as string, s.work)).toBe(0)
  const B = join(s.work, `backup-demo-${STAMP}`)
  expect(statSync(B).mode & 0o777).toBe(0o700)
  for (const f of ['main/db.sql', 'instad.env', 'tls-cert.pem', 'tls-key.pem']) expect(existsSync(join(B, f)), f).toBe(true)
  expect(readFileSync(join(B, 'default-branch'), 'utf8').trim()).toBe('main')
  expect(readFileSync(join(B, 'project'), 'utf8').trim()).toBe('demo')
  expect(readFileSync(join(B, 'tls-cert.pem'), 'utf8')).toBe('CERT')
  expect(readFileSync(join(B, 'tls-key.pem'), 'utf8')).toBe('KEY')
  expect(statSync(join(B, 'main/db.sql')).mode & 0o077).toBe(0)
})

// Branches carry different services, and `a` + `b-c` and `a-b` + `c` are both valid names: a flat
// `<branch>-<service>.sql` would write one file for both.
const DIVERGENT = { main: ['analytics', 'db'], feat: ['db'], a: ['b-c'], 'a-b': ['c'], empty: [] }

test('the dump block dumps exactly what each branch carries, one directory per branch, no name collisions', () => {
  const s = sandbox(DIVERGENT)
  writeFileSync(join(s.etc, 'instad.env'), 'INSTA_OSS_TLS=acme\n')
  expect(s.run(dumpBlock as string, s.work)).toBe(0)
  const B = join(s.work, `backup-demo-${STAMP}`)
  for (const f of ['main/db.sql', 'main/analytics.sql', 'feat/db.sql', 'a/b-c.sql', 'a-b/c.sql']) expect(existsSync(join(B, f)), f).toBe(true)
  expect(existsSync(join(B, 'feat/analytics.sql'))).toBe(false)
  expect(readFileSync(join(B, 'a/b-c.sql'), 'utf8')).toContain('postgres://stub/a/b-c')
  expect(readFileSync(join(B, 'a-b/c.sql'), 'utf8')).toContain('postgres://stub/a-b/c')
  expect(existsSync(join(B, 'empty'))).toBe(true)
})

test('a dump that fails stops the block but still leaves the secrets in the backup directory', () => {
  const s = sandbox()
  writeFileSync(join(s.etc, 'instad.env'), 'INSTA_OSS_TLS=acme\n')
  expect(s.run(dumpBlock as string, s.work, { FAIL_DUMP: '1' })).toBeGreaterThan(0)
  expect(existsSync(join(s.work, `backup-demo-${STAMP}`, 'instad.env'))).toBe(true)
})

test('the dump block stops, writing nothing, when the backup directory already exists', () => {
  const s = sandbox()
  writeFileSync(join(s.etc, 'instad.env'), 'INSTA_OSS_TLS=acme\n')
  const B = join(s.work, `backup-demo-${STAMP}`)
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
  expect(s.log('docker.log')).toBe('')
  expect(readFileSync(join(s.etc, 'instacloud-data.tgz'), 'utf8')).toBe('GOOD')

  expect(s.run(archiveBlock as string, s.work, { FAKE_UID: '0', FAIL_TAR: '1' })).toBeGreaterThan(0)
  expect(readFileSync(join(s.etc, 'instacloud-data.tgz'), 'utf8')).toBe('GOOD')
  expect(existsSync(join(s.etc, 'instacloud-data.tgz.tmp'))).toBe(false)
  expect(s.log('docker.log')).toContain('docker compose start')

  // A stop that fails partway (some services already down) still brings the stack back.
  writeFileSync(join(s.root, 'docker.log'), '')
  expect(s.run(archiveBlock as string, s.work, { FAKE_UID: '0', FAIL_STOP: '1' })).toBeGreaterThan(0)
  expect(s.log('docker.log')).toMatch(/docker compose stop\ndocker compose start/)
  expect(readFileSync(join(s.etc, 'instacloud-data.tgz'), 'utf8')).toBe('GOOD')

  // A failed branch-container listing must not let tar read files those containers may still be writing.
  writeFileSync(join(s.root, 'docker.log'), '')
  expect(s.run(archiveBlock as string, s.work, { FAKE_UID: '0', FAIL_PS: '1' })).toBeGreaterThan(0)
  expect(readFileSync(join(s.etc, 'instacloud-data.tgz'), 'utf8')).toBe('GOOD')
  expect(s.log('docker.log')).toContain('docker compose start')

  // Branch containers are listed and stopped; a stop that fails leaves the good archive alone.
  writeFileSync(join(s.root, 'docker.log'), '')
  expect(s.run(archiveBlock as string, s.work, { FAKE_UID: '0', BRANCH_IDS: 'abc123', FAIL_BRANCH_STOP: '1' })).toBeGreaterThan(0)
  expect(s.log('docker.log')).toContain('docker stop abc123')
  expect(readFileSync(join(s.etc, 'instacloud-data.tgz'), 'utf8')).toBe('GOOD')

  writeFileSync(join(s.root, 'docker.log'), '')
  expect(s.run(archiveBlock as string, s.work, { FAKE_UID: '0', BRANCH_IDS: 'abc123' })).toBe(0)
  expect(s.log('docker.log')).toMatch(/docker stop abc123[\s\S]*docker compose start/)
  expect(readFileSync(join(s.etc, 'instacloud-data.tgz')).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
  expect(statSync(join(s.etc, 'instacloud-data.tgz')).mode & 0o777).toBe(0o600)
  expect(existsSync(join(s.etc, 'instacloud-data.tgz.tmp'))).toBe(false)
})

// `insta branch create` clones its parent's data, so a recovery that creates a branch after a service exists
// clones that service (and any data already loaded) into it. The recovery must rebuild exactly the layout it
// dumped, clone nothing, and load every dump only after the last create, each one fail-fast.
test('the recovery block rebuilds exactly the dumped layout, clones nothing, and loads last', () => {
  expect(recoveryBlock, 'the page must carry the recovery block').toBeDefined()
  for (const layout of [{ main: ['db'] }, DIVERGENT]) {
    const s = sandbox(layout)
    writeFileSync(join(s.etc, 'instad.env'), 'INSTA_OSS_TLS=acme\n')
    const before = s.box()
    expect(s.run(dumpBlock as string, s.work), JSON.stringify(layout)).toBe(0)

    // A new machine: no project yet.
    rmSync(join(s.root, 'box'), { recursive: true, force: true }); mkdirSync(join(s.root, 'box'))
    writeFileSync(join(s.root, 'calls.log'), '')
    const recovery = (recoveryBlock as string).replace(/^B=\S+/m, `B=backup-demo-${STAMP}`)
    expect(s.run(recovery, s.work), `recovery ${JSON.stringify(layout)}`).toBe(0)

    expect(s.box()).toEqual(before)
    expect(readFileSync(join(s.root, 'box/.project'), 'utf8').trim()).toBe('p-demo demo')
    expect(s.log('clones.log'), 'a branch was created from a parent that already had services').toBe('')
    const calls = s.log('calls.log').trim().split('\n')
    const firstLoad = calls.findIndex((c) => c.startsWith('psql '))
    const lastCreate = Math.max(...calls.map((c, i) => (/^insta (project create|services add|branch create)/.test(c) ? i : -1)))
    expect(firstLoad, calls.join('\n')).toBeGreaterThan(lastCreate)
    const loads = calls.filter((c) => c.startsWith('psql '))
    expect(loads.length).toBe(Object.values(layout).flat().length)
    for (const c of loads) expect(c).toMatch(/-v ON_ERROR_STOP=1 --single-transaction/)
  }
})

test('the recovery block stops before loading anything when the backup directory is wrong', () => {
  const s = sandbox()
  rmSync(join(s.root, 'box'), { recursive: true, force: true }); mkdirSync(join(s.root, 'box'))
  const recovery = (recoveryBlock as string).replace(/^B=\S+/m, 'B=backup-missing')
  expect(s.run(recovery, s.work)).toBeGreaterThan(0)
  expect(s.log('calls.log')).not.toContain('psql ')
})

// The CLI acts on the linked project only, so the block is per project: it refuses to run unlinked, and
// two projects backed up in turn land in two directories rather than one that silently holds a single project.
test('the dump block is per project: it refuses an unlinked directory and names each backup for its project', () => {
  const unlinked = sandbox({ main: ['db'] }, '')
  writeFileSync(join(unlinked.etc, 'instad.env'), 'INSTA_OSS_TLS=acme\n')
  expect(unlinked.run(dumpBlock as string, unlinked.work)).toBeGreaterThan(0)
  expect(readdirSync(unlinked.work)).toEqual([])

  const s = sandbox({ main: ['db'] }, 'shop')
  writeFileSync(join(s.etc, 'instad.env'), 'INSTA_OSS_TLS=acme\n')
  expect(s.run(dumpBlock as string, s.work)).toBe(0)
  s.setBox({ main: ['events'] })
  writeFileSync(join(s.root, 'box/.project'), 'p-blog blog\n')
  expect(s.run(dumpBlock as string, s.work)).toBe(0)
  expect(readdirSync(s.work).sort()).toEqual([`backup-blog-${STAMP}`, `backup-shop-${STAMP}`])
  expect(existsSync(join(s.work, `backup-shop-${STAMP}`, 'main/db.sql'))).toBe(true)
  expect(existsSync(join(s.work, `backup-blog-${STAMP}`, 'main/events.sql'))).toBe(true)
})
