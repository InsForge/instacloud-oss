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

// The whole baseline, not a sample. Asserting the parity of three lists only catches a package
// dropped from one box; spelling the list out here is what catches one dropped from all three,
// which is the way a tool the READMEs promise would actually go missing.
const BASELINE = [
  'bash', 'bc', 'bind9-dnsutils', 'build-essential', 'ca-certificates', 'curl', 'fzf', 'git',
  'gnupg', 'htop', 'iproute2', 'jq', 'less', 'lsof', 'nano', 'net-tools', 'openssh-client',
  'procps', 'psmisc', 'python3', 'python3-pip', 'python3-venv', 'ripgrep', 'rsync', 'socat',
  'sudo', 'tmux', 'tree', 'unzip', 'vim-tiny', 'wget', 'zip',
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

  it.each(boxes)('$code installs the whole baseline and nothing is quietly dropped', ({ dockerfile }) => {
    expect(aptPackages(dockerfile)).toEqual(BASELINE)
  })

  // Debian's own gh is years behind, so it comes from upstream's repository and is not pinned.
  it.each(boxes)('$code installs gh from upstream', ({ dockerfile }) => {
    expect(dockerfile).toContain('https://cli.github.com/packages')
    expect(dockerfile).toMatch(/apt-get install -y --no-install-recommends gh\b/)
  })

  // Claude Code's channel plugins are Bun scripts: no bun, no channels. --allow-scripts is what
  // fetches the binary, and without it the install leaves a bun that cannot run.
  it.each(boxes)('$code installs bun with its postinstall allowed', ({ dockerfile }) => {
    expect(dockerfile).toMatch(/npm install -g --allow-scripts=bun bun\b/)
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

  // A token in the deploy form has to be enough on its own: gh signed in, git pointed at gh, and
  // a committer identity, or the first commit on a fresh box fails on something the form offered.
  it.each(boxes)('$code turns a GH_TOKEN into working git', ({ code, entrypoint }) => {
    expect(entrypoint).toContain('gh auth setup-git')
    expect(entrypoint).toMatch(/git config --global user\.name/)
    expect(entrypoint).toMatch(/git config --global user\.email/)
    // Guarded, so a name the user set themselves is never overwritten on the next boot.
    expect(entrypoint).toMatch(/git config --global --get user\.email/)
    expect(read(code, 'insta.template.yaml')).toMatch(/^\s+GH_TOKEN:$/m)
  })

  // tmux takes the mouse, so without this config a Mac cannot select text in the terminal. Only
  // the comments differ between boxes, where they name the agent, so compare the settings alone.
  it.each(boxes)('$code ships the same tmux settings', ({ code, dockerfile }) => {
    expect(dockerfile).toContain('COPY tmux.conf /etc/tmux.conf')
    expect(settings(read(code, 'tmux.conf'))).toEqual(settings(read('claude-code', 'tmux.conf')))
  })
})
