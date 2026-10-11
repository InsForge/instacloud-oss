// The three agent boxes are the same box with a different CLI, so they get the same tools. A tool
// added to one and forgotten in the others is the bug this file exists to catch (feedback on #204).
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (code, file) => (existsSync(join(root, code, file)) ? readFileSync(join(root, code, file), 'utf8') : '')
// Keyed on ttyd, like ttyd-gate.test.mjs, so a new terminal template cannot slip past.
const boxes = readdirSync(root)
  .filter((code) => /\bttyd\b/.test(read(code, 'Dockerfile') + read(code, 'entrypoint.sh')))
  .map((code) => ({ code, dockerfile: read(code, 'Dockerfile'), entrypoint: read(code, 'entrypoint.sh') }))

// The package list of the one `apt-get install` that carries the tools, continuation lines joined.
const aptPackages = (dockerfile) => {
  const block = dockerfile.replace(/\\\n\s*/g, ' ').match(/^RUN apt-get update && apt-get install -y --no-install-recommends (.+?) && rm -rf/m)
  return block ? block[1].trim().split(/\s+/).sort() : []
}
const pathLine = (dockerfile) => (dockerfile.match(/^ENV PATH=.*$/m) ?? [''])[0]
// A config file's lines with comments and blank lines dropped.
const settings = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))

// Each of these earns its place: without it something an agent routinely does fails outright.
const REQUIRED = [
  'build-essential', // npm install on any package with a native addon
  'python3-pip', // python3-venv alone cannot install anything
  'bind9-dnsutils', // dig
  'iproute2', // ss
  'lsof',
  'nano',
  'vim-tiny', // vi
  'git',
  'tmux',
  'jq',
]

describe('the agent boxes carry the same tools', () => {
  it('covers every agent box', () => {
    expect(boxes.map((b) => b.code)).toEqual(expect.arrayContaining(['claude-code', 'codex', 'pi']))
  })

  it('every box installs exactly the same packages', () => {
    const [first, ...rest] = boxes.map((b) => aptPackages(b.dockerfile))
    expect(first.length).toBeGreaterThan(0)
    for (const packages of rest) expect(packages).toEqual(first)
  })

  it.each(boxes)('$code installs the tools an agent cannot work without', ({ dockerfile }) => {
    expect(aptPackages(dockerfile)).toEqual(expect.arrayContaining(REQUIRED))
  })

  // Debian's own gh is years behind, so it comes from upstream's repository and is not pinned.
  it.each(boxes)('$code installs gh from upstream', ({ dockerfile }) => {
    expect(dockerfile).toContain('https://cli.github.com/packages')
    expect(dockerfile).toMatch(/apt-get install -y --no-install-recommends gh\b/)
  })

  // Claude Code's channel plugins are Bun scripts: no bun, no channels.
  it.each(boxes)('$code installs bun for both architectures', ({ dockerfile }) => {
    expect(dockerfile).toMatch(/bun-linux-\$\{bun_arch\}\.zip/)
    expect(dockerfile).toContain('bun_arch=x64')
    expect(dockerfile).toContain('bun_arch=aarch64')
    expect(dockerfile).toContain('/usr/local/bin/bunx')
  })

  // ~/.local/bin is on the volume, so an install there survives a restart; the toolbox is last.
  it('every box exports the same PATH', () => {
    const [first, ...rest] = boxes.map((b) => pathLine(b.dockerfile))
    expect(first).toBe('ENV PATH=$HOME/.local/bin:$PATH:/.insta/tools/bin')
    for (const line of rest) expect(line).toBe(first)
  })

  // ttyd kills its child when a tab closes, so the shell has to be a session that outlives it.
  it.each(boxes)('$code attaches every tab to the one tmux session', ({ entrypoint }) => {
    expect(entrypoint.replace(/\\\n\s*/g, ' ')).toMatch(/tmux -u new-session -A -s main/)
  })

  // tmux takes the mouse, so without this config a Mac cannot select text in the terminal. Only
  // the comments differ between boxes, where they name the agent, so compare the settings alone.
  it.each(boxes)('$code ships the same tmux settings', ({ code, dockerfile }) => {
    expect(dockerfile).toContain('COPY tmux.conf /etc/tmux.conf')
    expect(settings(read(code, 'tmux.conf'))).toEqual(settings(read('claude-code', 'tmux.conf')))
  })
})
