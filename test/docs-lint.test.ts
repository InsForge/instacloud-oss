// Copy and shape rules for the docs that ship with the repository. No Docker, no daemon: this
// suite only reads files, so it is cheap enough to keep in `npm test`.
import { test, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, accessSync, constants } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { dataLayout } from '../src/datadir'

const root = join(__dirname, '..')
const EM_DASH = '—'

const walk = (dir: string, keep: (f: string) => boolean): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`
    const st = statSync(join(root, rel))
    if (st.isDirectory()) out.push(...walk(rel, keep))
    else if (keep(entry)) out.push(rel)
  }
  return out
}

const mdxPages = () => walk('docs', (f) => f.endsWith('.mdx'))

// Pages the em-dash sweep has not reached yet. Every entry is a page WP8 does not own; the list
// only ever shrinks, and a new page may never join it.
const EM_DASH_LEGACY = new Set([
  'docs/agents/branch-per-task.mdx',
  'docs/agents/mcp-server.mdx',
  'docs/agents/setup.mdx',
  'docs/agents/skills.mdx',
  'docs/compute/overview.mdx',
  'docs/deploy/overview.mdx',
  'docs/postgres/overview.mdx',
  'docs/reference/cli/overview.mdx',
  'docs/storage/overview.mdx',
])

test('docs copy uses no em dashes', () => {
  const files = [
    'README.md',
    'COMPATIBILITY.md',
    'CONTRIBUTING.md',
    'templates/AGENTS.md',
    ...mdxPages().filter((f) => !EM_DASH_LEGACY.has(f)),
    ...walk('e2e', () => true),
  ]
  const offenders = files.filter((f) => readFileSync(join(root, f), 'utf8').includes(EM_DASH))
  expect(offenders).toEqual([])
})

test('the em dash allowlist names only files that exist and still carry one', () => {
  for (const f of EM_DASH_LEGACY) {
    expect(readFileSync(join(root, f), 'utf8').includes(EM_DASH), `${f} is clean now`).toBe(true)
  }
})

test('every docs page is listed in the docs.json navigation', () => {
  const nav = JSON.parse(readFileSync(join(root, 'docs/docs.json'), 'utf8')) as unknown
  const listed = new Set<string>()
  const collect = (node: unknown): void => {
    if (typeof node === 'string') listed.add(node)
    else if (Array.isArray(node)) node.forEach(collect)
    else if (node && typeof node === 'object') Object.values(node).forEach(collect)
  }
  collect((nav as { navigation: unknown }).navigation)
  const missing = mdxPages()
    .map((f) => relative('docs', f).split(sep).join('/').replace(/\.mdx$/, ''))
    .filter((page) => !listed.has(page))
  expect(missing).toEqual([])
})

test('the e2e scripts are valid POSIX sh and executable', () => {
  for (const script of ['e2e/lib.sh', 'e2e/local-smoke.sh', 'e2e/server-smoke.sh']) {
    const path = join(root, script)
    execFileSync('sh', ['-n', path])
    expect(() => accessSync(path, constants.X_OK), `${script} is not executable`).not.toThrow()
  }
})

// With `--tls internal` the daemon issues its own CA and every client has to be pointed at it
// through the variable IT reads. The installer's guidance and the TLS docs listed three and left
// out `AWS_CA_BUNDLE`, the only one an S3 client reads, so anyone who followed them got a working
// curl, psql and CLI and an upload that failed with "unable to get local issuer certificate".
// The e2e server smoke ran into exactly that. All four are named in all three places, together.
test('the internal-CA guidance names the variable every client reads, S3 included', () => {
  const vars = ['--cacert', 'PGSSLROOTCERT', 'NODE_EXTRA_CA_CERTS', 'AWS_CA_BUNDLE']
  const install = readFileSync(join(root, 'install.sh'), 'utf8')
  const guidance = install.split('\n').find((l) => l.includes('internal issuer:'))
  expect(guidance, 'install.sh prints no internal-issuer guidance').toBeDefined()
  for (const v of vars) expect(guidance, `install.sh guidance omits ${v}`).toContain(v)

  const domains = readFileSync(join(root, 'docs/self-hosting/domains.mdx'), 'utf8')
  for (const v of vars) expect(domains, `docs/self-hosting/domains.mdx omits ${v}`).toContain(v)
  // Clients run off the box, where the server's /var/lib/instacloud/edge/ca.pem does not exist: every
  // client line points at the copy the page fetches first, never at the server path.
  const clientLines = domains.split('\n').filter((l) => vars.some((v) => l.includes(`${v} `) || l.includes(`${v}=`)))
  expect(clientLines.length).toBeGreaterThanOrEqual(vars.length)
  for (const l of clientLines) {
    expect(l, l).toContain('instacloud-ca.pem')
    expect(l, l).not.toContain('/var/lib/instacloud/edge/ca.pem')
  }
  expect(domains).toMatch(/ssh \S+@<box> sudo cat \/var\/lib\/instacloud\/edge\/ca\.pem > \.\/instacloud-ca\.pem/)

  // ...and the smoke script exports what it tells operators to export.
  const smoke = readFileSync(join(root, 'e2e/server-smoke.sh'), 'utf8')
  for (const v of ['PGSSLROOTCERT', 'NODE_EXTRA_CA_CERTS', 'AWS_CA_BUNDLE']) {
    expect(smoke, `e2e/server-smoke.sh never exports ${v}`).toContain(`export ${v}`)
  }
})

const FIXTURE = 'e2e/fixtures/tpl-hello/insta.template.yaml'

test('the e2e template fixture is a valid draft manifest', async () => {
  const text = readFileSync(join(root, FIXTURE), 'utf8')
  // Pinned to a tag, never a floating one: a fixture that drifts turns an e2e failure into a
  // guessing game.
  expect(text).toMatch(/image: docker\.io\/traefik\/whoami:v[0-9]/)
  expect(text).toMatch(/^ {2}draft: true$/m)
  expect(text).toMatch(/^ {2}category: /m)

  // The parser is WP5's module. Until it lands, the shape checks above stand on their own.
  let parse: ((input: string, opts: { rejectAuthoredSizing: boolean }) => unknown) | undefined
  let collect: ((m: unknown) => { name: string; description?: string; required?: boolean }[]) | undefined
  try {
    const mod = (await import('../src/templates/manifest')) as Record<string, unknown>
    parse = mod.parseTemplateManifest as typeof parse
    collect = mod.collectVariables as typeof collect
  } catch {
    parse = undefined
  }
  if (!parse) return

  const manifest = parse(text, { rejectAuthoredSizing: true }) as {
    code: string
    meta?: { draft?: boolean }
  }
  expect(manifest.code).toBe('tpl-hello')
  expect(manifest.meta?.draft).toBe(true)
  if (collect) {
    for (const v of collect(manifest).filter((x) => x.required)) {
      expect(v.description, `${v.name} has no description`).toBeTruthy()
    }
  }
})

// The verbs below are the ones the CLI actually ships. The invented ones are mistakes made
// while writing these docs, so the table is guarded against them coming back.
const CLI_VERBS = [
  'domain attach',
  'domain check',
  'domain detach',
  'compute limits',
  'compute always-on',
  'template list',
  'template info',
  'template deploy',
  'postgres url',
  'postgres always-on',
  'services add postgres',
  'POST /tokens',
]

// Commands that do not exist. `insta policy` was RETIRED from the CLI (insta-cli's
// test/retired-policy.test.ts pins "unknown command 'policy'"); opt-in approval is the dashboard's
// policy matrix or PUT /projects/:id/policy/:action. It was being recommended to operators anyway.
const INVENTED = ['compute domain add', 'insta compute domain', 'tokens list', 'insta tokens', 'insta policy']

test('the README and the docs pages name no command that does not exist', () => {
  for (const rel of ['README.md', ...mdxPages()]) {
    // "There is no `insta tokens` command" is the correct way to mention one, so it is not a hit.
    const text = readFileSync(join(root, rel), 'utf8').replace(/\bno `[^`]+` command/g, '')
    // Whole words only: `insta compute domain` must not match inside a longer name, and must match at a line end.
    const hit = (v: string) => new RegExp(`(^|[^\\w-])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'm').test(text)
    expect(INVENTED.filter(hit), rel).toEqual([])
  }
})

test('COMPATIBILITY names every new route by its real verb', () => {
  const text = readFileSync(join(root, 'COMPATIBILITY.md'), 'utf8')
  expect(CLI_VERBS.filter((v) => !text.includes(v))).toEqual([])
  expect(INVENTED.filter((v) => text.includes(v))).toEqual([])
  // `insta backup` does not exist, so the only allowed mention is the one that says so.
  expect(text).toMatch(/no `insta backup` command/)
})

// The backup page is the ONLY documented recovery path (the backups API answers 501), so what it
// tells the operator to archive is derived from the code rather than trusted: `md/` was missing
// from it, which loses every managed database from a backup that appears to succeed.
test('the backup procedure covers every data root the code writes, and stops the writers first', () => {
  const page = readFileSync(join(root, 'docs/self-hosting/upgrade.mdx'), 'utf8')
  const tarLine = page.split('\n').find((l) => l.startsWith('tar -C /var/lib/instacloud -czf'))
  expect(tarLine, 'the page must carry one tar line').toBeDefined()

  // Every branch data root `dataLayout` mints, taken FROM the layout: the next person who adds
  // one finds out here when this page stops covering it.
  const roots = dataLayout('/var/lib/instacloud').branchRoots('ref').map((p) => p.split('/')[4])
  expect(roots).toContain('md')                       // the one that was missing
  for (const root_ of roots) expect(tarLine, root_).toMatch(new RegExp(`\\s${root_}(\\s|$)`))
  // ...plus the state file and the two stores that are not per branch.
  for (const extra of ['state.json', 'garage', 'edge', 'caddy']) {
    expect(tarLine, extra).toMatch(new RegExp(`\\s${extra.replace('.', '\\.')}(\\s|$)`))
  }

  // The stop ORDER: the compose stack and then the branch containers, both BEFORE the tar. The
  // branch containers are not part of the stack, so `docker compose stop` does not touch them,
  // and an archive taken while they write is torn for those services.
  const compose = page.indexOf('docker compose stop')
  const branches = page.indexOf("docker ps -q --filter 'name=^io-'")
  const tar = page.indexOf('tar -C /var/lib/instacloud -czf')
  expect(compose).toBeGreaterThan(0)
  expect(branches).toBeGreaterThan(compose)
  expect(tar).toBeGreaterThan(branches)

  // And the restore side, which the page did not have at all.
  expect(page).toContain('Restore, on a clean machine')
  expect(page).toContain('tar -C /var/lib/instacloud -xzf')
  // It says what the archive is NOT consistent for, rather than overclaiming.
  expect(page).toMatch(/NOT for a service that was running/)
})
