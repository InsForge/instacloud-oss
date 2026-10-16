// The bundled template registry: the `templates/` directory served through the cloud's two public
// catalog routes (GET /templates, GET /templates/:code). There is no registry to call and no
// network access anywhere in here, which is the point: a self-hosted daemon deploys the same eight
// templates offline, and a logo travels as a data: URI rather than a CDN URL (decision 29).
//
// Response shapes mirror insta-platform TemplateService.listTemplates / getTemplate at 9f0c0d3,
// including the deprecated deployCount / activeDeployCount aliases the console still reads. The
// numbers are per daemon: this box's own deployments, not a global gallery counter.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { hostArch } from '../hostarch'
import { loadState } from '../state'
import type { TemplateDeploymentRecord } from '../types'
import {
  collectVariables, manifestArchitectures, parseTemplateManifest, TEMPLATE_README_MAX_BYTES,
  type TemplateManifest, type TemplateVariable,
} from './manifest'

/** Directory entries that are never a template. */
const SKIP_DIRS = new Set(['scripts', 'node_modules', 'assets'])
const MANIFEST_FILE = 'insta.template.yaml'
/** `meta.logo: none` is an explicit "this template has no logo", not a missing file. */
const LOGO_NONE = 'none'
const LOGO_FALLBACKS = ['logo.svg', 'logo.png']
const LOGO_MIME: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png' }

/** One template as the catalog knows it: the parsed manifest plus the files beside it. */
export interface CatalogEntry {
  manifest: TemplateManifest
  /** `meta.draft: true`: hidden from the listing, 404 on the detail route. */
  draft: boolean
  readme: string | null
  logoUrl: string | null
  license: string | null
  documentationUrl: string | null
  source: string
  updatedAt: string
}

/** Per-code deployment counters, computed from this daemon's own state. */
export interface CatalogStats {
  totalProjects: number
  activeProjects: number
  deploymentCount: number
  activeDeploymentCount: number
  successRate: number | null
}

/** A code that is unknown or still a draft: the route answers 404 with this message. */
export class TemplateNotFoundError extends Error {
  constructor(code: string) {
    super(`template not found: ${code}`)
    this.name = 'TemplateNotFoundError'
  }
}

// ---- README deploy-button stripping ------------------------------------------------------------
// The bundled READMEs carry a "Deploy on InstaCloud" button authored for GitHub, where a template
// directory has no deploy affordance of its own. Served through this catalog the same text sits
// beside a dashboard that already has a Deploy button, so the badge is stripped exactly as the
// registry's publisher strips it (templates/scripts/publish-lib.mjs stripDeployBadge) rather than
// by a looser matcher that could eat a neighbouring image.
const DEPLOY_BUTTON_ASSET = 'assets/deploy-button.svg'
const DEPLOY_BUTTON_LINE = new RegExp(
  `^[ ]{0,3}\\[!\\[[^\\]]*\\]\\((?:[^)\\s]*/)?${DEPLOY_BUTTON_ASSET.replace(/[.]/g, '\\.')}(?:[?#][^)\\s]*)?\\)\\]\\(([^)\\s]*)\\)[ \\t]*$`,
)
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** Line indexes carrying the deploy button, skipping fenced samples of it. */
function scanDeployButtons(text: string): { lines: string[]; hits: Set<number> } {
  const lines = String(text ?? '').split('\n')
  const hits = new Set<number>()
  // Tracked as the OPENING fence's character and length, not a parity flip: CommonMark closes a
  // fence only with the same character, at least as long, carrying nothing else.
  let fence: { char: string; len: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE.exec(lines[i])
    if (f) {
      const char = f[1][0]
      if (!fence) {
        if (char !== '`' || !f[2].includes('`')) fence = { char, len: f[1].length }
      } else if (char === fence.char && f[1].length >= fence.len && f[2].trim() === '') {
        fence = null
      }
      continue
    }
    if (fence) continue
    if (DEPLOY_BUTTON_LINE.test(lines[i])) hits.add(i)
  }
  return { lines, hits }
}

/** The README with the button line, and the blank line it leaves behind, removed. */
export function stripDeployBadge(text: string): string {
  const { lines, hits } = scanDeployButtons(text)
  if (!hits.size) return text
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!hits.has(i)) { out.push(lines[i]); continue }
    // The button sits in its own paragraph, so removing the line alone would leave the blank line
    // above AND below it: take the trailing one, and only when a blank line is already standing.
    const nextIsBlank = lines[i + 1] !== undefined && lines[i + 1].trim() === ''
    const prevIsBlank = out.length > 0 && out[out.length - 1].trim() === ''
    if (nextIsBlank && prevIsBlank) i++
  }
  return out.join('\n')
}

// ---- the catalog -------------------------------------------------------------------------------

export class TemplateCatalog {
  private cache: { key: string; entries: CatalogEntry[] } | null = null

  constructor(private readonly dir: string) {}

  /** Every readable template in the directory, newest parse cached by the manifests' mtimes. */
  load(): CatalogEntry[] {
    const dirs = this.templateDirs()
    const key = dirs.map((d) => `${d}:${this.mtimeOf(join(this.dir, d, MANIFEST_FILE))}`).join('|')
    if (this.cache?.key === key) return this.cache.entries
    const entries: CatalogEntry[] = []
    for (const name of dirs) {
      const entry = this.read(name)
      if (entry) entries.push(entry)
    }
    entries.sort((a, b) => a.manifest.code.localeCompare(b.manifest.code))
    this.cache = { key, entries }
    return entries
  }

  /** One entry by code, drafts included (the deploy path may target a draft by inline manifest). */
  find(code: string): CatalogEntry | undefined {
    return this.load().find((e) => e.manifest.code === code)
  }

  /** The manifest a by-code deploy runs, or a 404-class throw (a draft is not deployable by code). */
  manifestFor(code: string): TemplateManifest {
    const entry = this.find(code)
    if (!entry || entry.draft) throw new TemplateNotFoundError(code)
    return entry.manifest
  }

  private templateDirs(): string[] {
    let names: string[]
    try { names = readdirSync(this.dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) }
    catch { return [] }
    return names.filter((n) => !n.startsWith('.') && !SKIP_DIRS.has(n)).sort()
  }

  private mtimeOf(path: string): number {
    try { return statSync(path).mtimeMs } catch { return 0 }
  }

  /** Parse one directory. A manifest that does not parse, or whose code disagrees with its
   *  directory name, is WARNED about and skipped: one bad template must not 500 the whole catalog
   *  on a public route. */
  private read(name: string): CatalogEntry | null {
    const base = join(this.dir, name)
    const manifestPath = join(base, MANIFEST_FILE)
    let text: string
    try { text = readFileSync(manifestPath, 'utf8') } catch { return null }
    let raw: TemplateManifest
    try {
      // Lenient: a bundled manifest is STORED content here, not an authored upload, so an
      // authored-sizing field is dropped rather than made to hide the whole template.
      raw = parseTemplateManifest(text, { rejectAuthoredSizing: false })
    } catch (e) {
      console.warn(`templates: skipping ${name}: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
    if (raw.code !== name) {
      console.warn(`templates: skipping ${name}: manifest code '${raw.code}' does not match its directory name`)
      return null
    }
    return {
      manifest: raw,
      draft: raw.meta?.draft === true,
      readme: this.readme(base),
      logoUrl: this.logo(base, raw.meta?.logo),
      license: raw.upstream?.license ?? null,
      documentationUrl: raw.meta?.links?.documentation ?? null,
      source: raw.maintainer ?? 'official',
      updatedAt: new Date(this.mtimeOf(manifestPath)).toISOString(),
    }
  }

  private readme(base: string): string | null {
    let text: string
    try { text = readFileSync(join(base, 'README.md'), 'utf8') } catch { return null }
    // Oversize reads as absent rather than being truncated: half a document served as a whole one
    // is worse than no panel at all.
    if (Buffer.byteLength(text, 'utf8') > TEMPLATE_README_MAX_BYTES) return null
    const stripped = stripDeployBadge(text)
    return stripped.trim() ? stripped : null
  }

  /** The logo as a data: URI, so the catalog is self-contained and works offline (decision 29). */
  private logo(base: string, declared: string | undefined): string | null {
    if (declared === LOGO_NONE) return null
    const candidates = declared ? [declared.replace(/^\.\//, '')] : LOGO_FALLBACKS
    const root = resolve(base)
    for (const rel of candidates) {
      const mime = LOGO_MIME[extname(rel).toLowerCase()]
      if (!mime) continue
      // `meta.logo` is authored data and `INSTA_OSS_TEMPLATES_DIR` is operator-settable, so the
      // path has to stay inside the template's own directory: a public, unauthenticated route
      // returns these bytes, and `../../..` would make it read anything the daemon can.
      const path = resolve(root, rel)
      if (path !== root && !path.startsWith(root + sep)) continue
      try {
        const bytes = readFileSync(path)
        return `data:${mime};base64,${bytes.toString('base64')}`
      } catch { /* declared but absent: fall through to null, the UI tolerates it */ }
    }
    return null
  }

  // ---- deployment counters ---------------------------------------------------------------------

  /** This daemon's deployment counters for one code. `loadState` clones the whole state file, so a
   *  caller that needs several codes reads it ONCE and passes it in: `GET /templates` is public and
   *  unauthenticated, and one clone per template turned a listing into seven. */
  stats(code: string, state = loadState()): CatalogStats {
    const rows = Object.values(state.templateDeployments ?? {}).filter((r) => r.templateCode === code)
    const live = rows.filter((r) => this.isLive(r, state.projects))
    const concluded = rows.filter((r) => (r.status === 'succeeded' || r.status === 'failed' || r.status === 'partial')
      // A row the daemon abandoned mid-run says nothing about the template: counting it would make
      // every restart look like an authoring failure.
      && !(r.error ?? '').startsWith('the daemon restarted'))
    const succeeded = concluded.filter((r) => r.status === 'succeeded').length
    return {
      totalProjects: new Set(rows.map((r) => r.projectId)).size,
      activeProjects: new Set(live.map((r) => r.projectId)).size,
      deploymentCount: rows.length,
      activeDeploymentCount: live.length,
      // null, NOT 0, when nothing has concluded: no data is not a 0 percent success rate.
      successRate: concluded.length ? Math.round((succeeded / concluded.length) * 100) : null,
    }
  }

  /** A deployment is live when it succeeded and at least one service it created is still
   *  registered against it (removing them all retires the deployment without deleting its row). */
  private isLive(row: TemplateDeploymentRecord, projects: ReturnType<typeof loadState>['projects']): boolean {
    if (row.status !== 'succeeded') return false
    const project = projects[row.projectId]
    if (!project) return false
    for (const entry of Object.values(row.services)) {
      const sid = entry.serviceId
      if (!sid) continue
      if (project.serviceSettings?.[sid]?.templateDeploymentId === row.id) return true
      if ((project.dbServices ?? []).some((d) => d.id === sid && d.templateDeploymentId === row.id)) return true
    }
    return false
  }

  // ---- route payloads --------------------------------------------------------------------------

  private variableGroups(manifest: TemplateManifest): { required: TemplateVariable[]; optional: TemplateVariable[] } {
    const vars = collectVariables(manifest)
    return { required: vars.filter((v) => v.required), optional: vars.filter((v) => !v.required) }
  }

  /** GET /templates: non-draft templates, filtered by exact category and free-text query.
   *
   *  `hostArchitecture` rides the envelope because it belongs to the BOX, not to any template:
   *  every row carries the architectures its image is published for, and a consumer that has both
   *  can grey out what this machine cannot run before someone clicks Deploy. The cloud's own
   *  gallery has no use for either field (it picks the machine), so this is additive on a route
   *  that already differs by serving the logo inline. */
  listTemplates(q: { query?: string; category?: string } = {}): { templates: Array<Record<string, unknown>>; hostArchitecture: string } {
    const wanted = q.category?.toLowerCase()
    const needle = q.query?.toLowerCase()
    const state = loadState()
    const templates = this.load()
      .filter((e) => !e.draft)
      .filter((e) => (wanted ? (e.manifest.meta?.category ?? '').toLowerCase() === wanted : true))
      .map((e) => {
        const meta = e.manifest.meta ?? {}
        const { required } = this.variableGroups(e.manifest)
        const s = this.stats(e.manifest.code, state)
        return {
          code: e.manifest.code,
          version: e.manifest.version,
          name: meta.name ?? e.manifest.code,
          tagline: meta.tagline,
          category: meta.category,
          tags: meta.tags ?? [],
          requiredVarCount: required.length,
          requiredVars: required.map((v) => ({ name: v.name, description: v.description, generate: v.generate })),
          totalProjects: s.totalProjects,
          activeProjects: s.activeProjects,
          successRate: s.successRate,
          // Deprecated deployment-unit aliases, kept because the console still renders them.
          deployCount: s.totalProjects,
          activeDeployCount: s.activeProjects,
          deploymentCount: s.deploymentCount,
          activeDeploymentCount: s.activeDeploymentCount,
          // The README belongs to the detail view: it would make this listing megabytes wide.
          logoUrl: e.logoUrl,
          license: e.license,
          architectures: manifestArchitectures(e.manifest),
          updatedAt: e.updatedAt,
        }
      })
      .filter((entry) => {
        if (!needle) return true
        const hay = `${entry.code} ${entry.name} ${entry.tagline ?? ''} ${(entry.tags as string[]).join(' ')}`.toLowerCase()
        return hay.includes(needle)
      })
    return { templates, hostArchitecture: hostArch() }
  }

  /** GET /templates/:code: the detail view; a draft or unknown code is a 404. */
  getTemplate(code: string): { template: Record<string, unknown>; hostArchitecture: string } {
    const e = this.find(code)
    if (!e || e.draft) throw new TemplateNotFoundError(code)
    const meta = e.manifest.meta ?? {}
    const s = this.stats(code)
    return {
      template: {
        code: e.manifest.code,
        version: e.manifest.version,
        maintainer: e.manifest.maintainer,
        source: e.source,
        name: meta.name ?? e.manifest.code,
        tagline: meta.tagline,
        category: meta.category,
        tags: meta.tags ?? [],
        upstream: e.manifest.upstream,
        services: e.manifest.services,
        variables: this.variableGroups(e.manifest),
        constraints: e.manifest.constraints,
        totalProjects: s.totalProjects,
        activeProjects: s.activeProjects,
        successRate: s.successRate,
        deployCount: s.totalProjects,
        activeDeployCount: s.activeProjects,
        deploymentCount: s.deploymentCount,
        activeDeploymentCount: s.activeDeploymentCount,
        logoUrl: e.logoUrl,
        readme: e.readme,
        license: e.license,
        architectures: manifestArchitectures(e.manifest),
        documentationUrl: e.documentationUrl,
        updatedAt: e.updatedAt,
      },
      hostArchitecture: hostArch(),
    }
  }
}
