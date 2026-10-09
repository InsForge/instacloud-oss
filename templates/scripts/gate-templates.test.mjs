// Every template that signs visitors in through the InstaCloud sign-in page (gate/, released as
// gate-v*) downloads a checked release, and its app answers only behind the gate. Every ttyd
// template is one of them. Spec: plans/2026-10-08-ttyd-login-gate-spec.md
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (code, file) => (existsSync(join(root, code, file)) ? readFileSync(join(root, code, file), 'utf8') : '')
const templates = readdirSync(root).map((code) => ({
  code,
  dockerfile: read(code, 'Dockerfile'),
  entrypoint: read(code, 'entrypoint.sh'),
  nginx: read(code, 'nginx.conf'),
  manifest: read(code, 'insta.template.yaml'),
}))
// Keyed on ttyd itself, like ttyd-patch.test.mjs, so a new terminal template cannot slip past.
const ttyd = templates.filter((t) => /\bttyd\b/.test(t.dockerfile + t.entrypoint))
// Keyed on where the gate is installed, so a template that adopts it gets every check below.
const gated = templates.filter((t) => t.dockerfile.includes('/usr/local/lib/insta-gate.mjs'))

const DOWNLOAD = '"https://github.com/InsForge/instacloud-oss/releases/download/gate-v${INSTA_GATE_VERSION}/insta-gate.mjs"'
const CHECK = 'echo "${INSTA_GATE_SHA256}  /usr/local/lib/insta-gate.mjs" | sha256sum -c -'
const pins = (text) => [...text.matchAll(/^ARG (INSTA_GATE_\w+)=(\S+)$/gm)].map((m) => `${m[1]}=${m[2]}`)
// The command that starts the gate, continuation lines joined: exec'd when the gate is the main
// process, backgrounded when the entrypoint supervises it beside something else.
const gateLine = (text) =>
  (text.replace(/\\\n\s*/g, ' ').match(/^(?:exec )?node \/usr\/local\/lib\/insta-gate\.mjs .*$/m) ?? [''])[0].replace(/\s+/g, ' ')
const gateArgs = (line) => line.slice(0, line.indexOf(' -- '))
const childArgs = (line) => line.slice(line.indexOf(' -- ') + ' -- '.length)
// The gate's own defaults, for a template that leaves a flag out.
const flag = (line, name, fallback) => Number((gateArgs(line).match(new RegExp(`--${name} (\\d+)`)) ?? [])[1] ?? fallback)

describe('templates sign in through the gate', () => {
  it('covers the ttyd templates, dsh and open-slide', () => {
    expect(gated.map((t) => t.code)).toEqual(expect.arrayContaining(['claude-code', 'codex', 'pi', 'dsh', 'open-slide']))
  })

  it('every ttyd template is one of them', () => {
    expect(ttyd.map((t) => t.code)).toEqual(expect.arrayContaining(['claude-code', 'codex', 'pi']))
    for (const { code } of ttyd) expect(gated.map((t) => t.code)).toContain(code)
  })

  it.each(gated)('$code downloads the gate release and checks it before use', ({ dockerfile }) => {
    const download = dockerfile.indexOf(DOWNLOAD)
    expect(download).toBeGreaterThan(-1)
    expect(dockerfile.indexOf(CHECK, download)).toBeGreaterThan(download)
  })

  // 0.1.0 let another tenant's page open a signed-in terminal's WebSocket (same site, since
  // instacloud-edge.com is not on the Public Suffix List). 0.1.1 is the first gate safe to ship.
  it.each(gated)('$code pins gate 0.1.1 or later', ({ dockerfile }) => {
    const version = (dockerfile.match(/^ARG INSTA_GATE_VERSION=(\d+)\.(\d+)\.(\d+)$/m) ?? []).slice(1).map(Number)
    expect(version).toHaveLength(3)
    const [major, minor, patch] = version
    expect(major > 0 || minor > 1 || (minor === 1 && patch >= 1)).toBe(true)
  })

  it('every gated template pins the same gate version and checksum', () => {
    const [first, ...rest] = gated.map((t) => pins(t.dockerfile))
    expect(first.map((p) => p.split('=')[0])).toEqual(['INSTA_GATE_VERSION', 'INSTA_GATE_SHA256'])
    for (const p of rest) expect(p).toEqual(first)
  })

  it.each(gated)('$code starts the gate on its routed port, named for the template', ({ code, entrypoint, manifest }) => {
    const line = gateLine(entrypoint)
    expect(line).toMatch(new RegExp(`^(exec )?node /usr/local/lib/insta-gate\\.mjs --name ${code}( |$)`))
    expect(childArgs(line)).not.toBe('')
    const services = Object.values(yaml.load(manifest).services)
    expect(services.map((s) => s.port)).toContain(flag(line, 'port', 7681))
  })

  it.each(gated)('$code still refuses to start without both credentials', ({ entrypoint }) => {
    expect(entrypoint).toContain('${ADMIN_USERNAME:?')
    expect(entrypoint).toContain('${ADMIN_PASSWORD:?')
  })

  it.each(gated)('$code no longer asks the browser for basic auth', ({ dockerfile, entrypoint, nginx }) => {
    expect(dockerfile + entrypoint + nginx).not.toMatch(/auth_basic|htpasswd|basic_auth|WWW-Authenticate/i)
  })

  it.each(ttyd)('$code runs ttyd behind the gate, on loopback, with no credential of its own', ({ entrypoint }) => {
    const line = gateLine(entrypoint)
    expect(line).toMatch(/^exec /)
    const ttydArgs = childArgs(line)
    expect(ttydArgs).toMatch(/^ttyd /)
    expect(ttydArgs).toMatch(/(^|\s)-i lo(\s|$)/)
    expect(ttydArgs).toMatch(new RegExp(`(^|\\s)-p ${flag(line, 'upstream-port', 7682)}(\\s|$)`))
    // Every form getopt_long takes: -c v, -cv, bundled -Wc v, --credential v, --credential=v.
    expect(ttydArgs).not.toMatch(/(^|\s)(-[A-Za-z]*c|--credential(=|\s|$))/)
  })

  it.each(gated.filter((t) => t.nginx))('$code keeps its nginx behind the gate, on loopback only', ({ entrypoint, nginx }) => {
    const line = gateLine(entrypoint)
    expect(childArgs(line)).toMatch(/^nginx /)
    const listens = [...nginx.matchAll(/^\s*listen\s+([^;]+);/gm)].map((m) => m[1].trim())
    expect(listens).toEqual([`127.0.0.1:${flag(line, 'upstream-port', 7682)}`])
  })

  it.each(gated.filter((t) => !t.nginx && !ttyd.includes(t)))('$code runs its app behind the gate, on loopback only', ({ entrypoint }) => {
    expect(childArgs(gateLine(entrypoint))).toMatch(/(^|\s)--host 127\.0\.0\.1(\s|$)/)
  })
})
