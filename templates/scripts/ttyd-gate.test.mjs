// Every ttyd template puts the InstaCloud sign-in page (gate/, released as gate-v*) in front of
// ttyd, and ttyd answers only behind it. Spec: plans/2026-10-08-ttyd-login-gate-spec.md
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (code, file) => (existsSync(join(root, code, file)) ? readFileSync(join(root, code, file), 'utf8') : '')
// Keyed on ttyd itself, like ttyd-patch.test.mjs, so a new terminal template cannot slip past.
const ttyd = readdirSync(root)
  .filter((code) => /\bttyd\b/.test(read(code, 'Dockerfile') + read(code, 'entrypoint.sh')))
  .map((code) => ({ code, dockerfile: read(code, 'Dockerfile'), entrypoint: read(code, 'entrypoint.sh'), manifest: read(code, 'insta.template.yaml') }))

const DOWNLOAD = '"https://github.com/InsForge/instacloud-oss/releases/download/gate-v${INSTA_GATE_VERSION}/insta-gate.mjs"'
const CHECK = 'echo "${INSTA_GATE_SHA256}  /usr/local/lib/insta-gate.mjs" | sha256sum -c -'
const pins = (text) => [...text.matchAll(/^ARG (INSTA_GATE_\w+)=(\S+)$/gm)].map((m) => `${m[1]}=${m[2]}`)
// The command the entrypoint execs, continuation lines joined.
const execLine = (text) => (text.replace(/\\\n\s*/g, ' ').match(/^exec .*$/m) ?? [''])[0].replace(/\s+/g, ' ')

describe('ttyd templates sign in through the gate', () => {
  it('covers every ttyd template', () => {
    expect(ttyd.map((t) => t.code)).toEqual(expect.arrayContaining(['claude-code', 'codex', 'pi']))
  })

  it.each(ttyd)('$code downloads the gate release and checks it before use', ({ dockerfile }) => {
    const download = dockerfile.indexOf(DOWNLOAD)
    expect(download).toBeGreaterThan(-1)
    expect(dockerfile.indexOf(CHECK, download)).toBeGreaterThan(download)
  })

  it('every ttyd template pins the same gate version and checksum', () => {
    const [first, ...rest] = ttyd.map((t) => pins(t.dockerfile))
    expect(first.map((p) => p.split('=')[0])).toEqual(['INSTA_GATE_VERSION', 'INSTA_GATE_SHA256'])
    for (const p of rest) expect(p).toEqual(first)
  })

  it.each(ttyd)('$code runs ttyd behind the gate, on loopback, with no credential of its own', ({ code, entrypoint }) => {
    const line = execLine(entrypoint)
    expect(line).toMatch(new RegExp(`^exec node /usr/local/lib/insta-gate\\.mjs --name ${code} -- ttyd `))
    const ttydArgs = line.slice(line.indexOf(' -- ttyd ') + ' -- ttyd '.length)
    expect(ttydArgs).toMatch(/(^|\s)-i lo(\s|$)/)
    expect(ttydArgs).toMatch(/(^|\s)-p 7682(\s|$)/)
    // Every form getopt_long takes: -c v, -cv, bundled -Wc v, --credential v, --credential=v.
    expect(ttydArgs).not.toMatch(/(^|\s)(-[A-Za-z]*c|--credential(=|\s|$))/)
  })

  it.each(ttyd)('$code still refuses to start without both credentials', ({ entrypoint }) => {
    expect(entrypoint).toContain('${ADMIN_USERNAME:?')
    expect(entrypoint).toContain('${ADMIN_PASSWORD:?')
  })

  it.each(ttyd)('$code routes the gate port', ({ manifest }) => {
    const services = Object.values(yaml.load(manifest).services)
    expect(services.map((s) => s.port)).toContain(7681)
  })
})
