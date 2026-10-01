// insta.template.yaml: parsing, validation and variable/generator semantics. A port of the pure
// half of the platform's authority (insta-platform src/provisioning/templateManifest.ts at
// 9f0c0d3), so a manifest that deploys on the cloud deploys here and `manifestDigest` matches byte
// for byte across both. Everything here is pure over the parsed document; the executor
// (executor.ts) owns every side effect.
//
// The one substitution: the platform's BadRequestError becomes ManifestError, which server.ts maps
// to 400. Canonical credential keys come from ../manageddb (the same catalog the engine mints from),
// not from a second copy of the table.
import { createHash, randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import YAML from 'yaml'
import { CANONICAL_KEYS } from '../manageddb'

/** A manifest the author must fix: 400 at the route, a run-ending reason in the background. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

// Template codes and service names both end up as platform names: the code becomes a default
// branch name (lower-kebab, same shape as branch/service names), the service name becomes the
// compute service / deploy group name (the engine's own service-name grammar).
//
// IMPORTED from the shared grammar (src/names.ts) rather than restated. These were local copies permitting a trailing
// hyphen, which the engine's own rules now reject, so `api-` passed validation here and then
// failed partway through deployment — after preliminary state such as the branch had been
// created. A parser that claims to apply the engine grammar has to use it.
import { BRANCH_NAME_RE, SERVICE_NAME_RE as ENGINE_SERVICE_NAME_RE } from '../names'

const CODE_RE = BRANCH_NAME_RE
const SERVICE_NAME_RE = ENGINE_SERVICE_NAME_RE
/** The one generator family: `secret:N` -> N chars from the CSPRNG. */
const GENERATOR_RE = /^secret:([1-9]\d{0,2})$/
// Generator NAMES are object keys that later feed lookups and ${...} refs, so the grammar excludes
// prototype-shaped names (__proto__, toString, ...) outright: lower_snake, letter-first.
const GENERATOR_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/
// A healthcheck is a PATH ON THE DEPLOYED SERVICE and the daemon itself fetches it, so the grammar
// excludes everything that could re-target that fetch at another origin (SSRF): exactly one leading
// '/', then a conservative path/query charset. This rejects '//host/x' (a network-path reference:
// `new URL('//h/x', base)` silently becomes https://h/x), any 'scheme:', backslashes (browsers and
// some clients fold '\' to '/'), userinfo '@', and control characters.
const HEALTHCHECK_RE = /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/
/** Env names, the same grammar user secrets use (platform secretNames.ts USER_SECRET_NAME_RE). */
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/

export type TemplateVarSpec = {
  description?: string
  default?: string
  generate?: string
  editable?: boolean
}

export type TemplateServiceEnv = {
  fixed: Record<string, string>
  generated: Record<string, string>   // ENV_NAME -> "${<declared generator>}"
  // Platform-injected credential RENAME mapping (the n8n shape): ENV_NAME ->
  // "${{services.<name>.<CANONICAL_KEY>}}". Resolved through the bindings seam, so the credential
  // itself is never copied and a later password rotation flows through without a redeploy.
  platform: Record<string, string>
  required: Record<string, TemplateVarSpec>
  optional: Record<string, TemplateVarSpec>
}

export type TemplateService = {
  type: 'web' | 'worker' | 'postgres'
  image?: string
  build?: string
  port?: number
  healthcheck?: string
  /** Needs a /data disk. Boolean: the daemon owns the size (INSTA_OSS_TEMPLATE_VOLUME_GIB). */
  volume?: boolean
  /** Opt out of sleep AT CREATION: a service whose work arrives on an OUTBOUND connection (a chat
   *  bot long-polling its platform) is never woken by traffic at all, so staying warm is
   *  correctness rather than latency. */
  alwaysOn?: boolean
  /** Start command, run through `sh -c`. Absent = the image's own. Parsed for digest parity, refused at execution. */
  command?: string
  /** Where the volume mounts. Only with `volume: true`. Absent = /data. Parsed for digest parity, refused at execution. */
  mountPath?: string
  env: TemplateServiceEnv
}

/** A parsed `${{services.<name>.<KEY>}}` platform-credential reference. */
export type PlatformRef = { service: string; key: string }
const PLATFORM_REF_RE = /^\$\{\{\s*services\.([a-z0-9][a-z0-9-]*)\.([A-Z][A-Z0-9_]*)\s*\}\}$/

/** Parse an env.platform value (already validated at manifest parse: this never fails for one). */
export function parsePlatformRef(ref: string): PlatformRef {
  const m = PLATFORM_REF_RE.exec(ref)
  if (!m) throw new ManifestError(`invalid platform credential reference: ${ref}`)
  return { service: m[1], key: m[2] }
}

export type TemplateConstraint = { oneOf?: string[]; allOf?: string[] }

// Catalog presentation. `logo` is directory-relative (`./logo.png`); the catalog turns it into a
// data: URI (decision 29). `links` is the author's outbound-link map: `documentation` is what the
// catalog serves as documentationUrl, and every value is parsed as an absolute https URL because
// any of them is a candidate for rendering on a page.
export type TemplateMeta = {
  name?: string; tagline?: string; category?: string; tags?: string[]
  logo?: string; links?: Record<string, string>
  draft?: boolean
  /** CPU architectures the template's deployable image is published for, in OCI naming. Absent is
   *  "no claim", not "both": an inline manifest a caller composed says nothing about a registry. */
  architectures?: string[]
}

/** The architectures a template may claim: the two `install.sh` accepts as a host. A third one
 *  belongs here only once the installer and the release image agree it is supported. */
export const TEMPLATE_ARCHITECTURES: readonly string[] = ['amd64', 'arm64']

/** The upstream pin, served verbatim (open shape). `license` is a typed catalog field. */
export type TemplateUpstream = { repo?: string; image?: string; pinned?: string; license?: string; [key: string]: unknown }

export type TemplateManifest = {
  code: string
  version: string
  maintainer?: string
  sourceRepo?: string
  upstream?: TemplateUpstream
  generated: Record<string, string>   // declare-once generators: name -> spec (secret:N)
  services: Record<string, TemplateService>
  constraints: TemplateConstraint[]
  meta?: TemplateMeta
  /** Authored variable order. */
  variableOrder: string[]
}

// One deploy-time variable, flattened out of the per-service required/optional maps into the
// global namespace the caller's `variables` map addresses (the same name declared by two services
// is ONE variable: merged, required if required anywhere).
export type TemplateVariable = {
  name: string
  description?: string
  required: boolean
  default?: string
  generate?: string
  editable?: boolean
}

/** The machine-readable half of the missing-variables 400: what to ask the user for. */
export type MissingVariable = { name: string; key: string; description?: string }

/** Required variables that resolve to no value: a 400 whose body carries the list, so callers
 *  prompt from it instead of parroting an opaque error (the CLI and MCP both branch on it). */
export class MissingTemplateVariablesError extends ManifestError {
  constructor(public missing: MissingVariable[]) {
    super('missing_variables')
    this.name = 'MissingTemplateVariablesError'
  }
}

const bad = (msg: string): never => { throw new ManifestError(`invalid template manifest: ${msg}`) }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

// String coercion for scalar env values: manifests legitimately write ports/flags as YAML
// numbers/booleans, and an env var is a string either way. Objects and arrays stay errors.
function scalarString(v: unknown, where: string): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return bad(`${where} must be a string`)
}

// Absolute-https gate as a reason string rather than a throw, so one predicate keeps the rule
// single-sourced. Every URL admitted here ends up rendered on a page, so the scheme check is the
// XSS guard: `javascript:` and `data:` are the payload shapes, and plain `http:` is a
// mixed-content hole on an https page.
function httpsUrlProblem(v: unknown): string | null {
  if (typeof v !== 'string') return 'must be a string'
  let url: URL
  try { url = new URL(v) } catch { return `must be an absolute URL, got: ${v}` }
  if (url.protocol !== 'https:') return `must be an absolute https URL (no ${url.protocol}, it is rendered on a page), got: ${v}`
  // Userinfo makes a URL read as one host while resolving to another; nothing legitimate needs it.
  if (url.username || url.password) return `must not carry credentials, got: ${v}`
  return null
}

function parseVarSpec(raw: unknown, where: string): TemplateVarSpec {
  // Bare-string shorthand for the description (the CLI accepts it; keep authors' lives easy).
  if (typeof raw === 'string') return { description: raw }
  if (!isRecord(raw)) return bad(`${where} must be an object or a description string`)
  const spec: TemplateVarSpec = {}
  if (raw.description !== undefined) spec.description = scalarString(raw.description, `${where}.description`)
  if (raw.default !== undefined) spec.default = scalarString(raw.default, `${where}.default`)
  if (raw.generate !== undefined) {
    const g = scalarString(raw.generate, `${where}.generate`)
    if (!GENERATOR_RE.test(g)) return bad(`${where}.generate must be secret:N (1-999), got: ${g}`)
    spec.generate = g
  }
  if (raw.editable !== undefined) {
    if (typeof raw.editable !== 'boolean') return bad(`${where}.editable must be a boolean`)
    spec.editable = raw.editable
  }
  return spec
}

function parseEnvNames(raw: unknown, where: string): Record<string, unknown> {
  if (raw === undefined) return {}
  if (!isRecord(raw)) return bad(`${where} must be a map`)
  for (const name of Object.keys(raw)) {
    if (!ENV_NAME_RE.test(name)) return bad(`${where}.${name}: env names must match ^[A-Z][A-Z0-9_]{0,63}$`)
  }
  return raw
}

/**
 * Parse and validate a manifest: a YAML/JSON string or an already-parsed document. Throws
 * ManifestError with an author-actionable message on any shape problem; what comes back is fully
 * normalized (every optional map present, every volume shape as `volume: true`).
 */
export function parseTemplateManifest(input: unknown, opts?: { rejectAuthoredSizing?: boolean }): TemplateManifest {
  let doc: unknown = input
  if (typeof input === 'string') {
    try { doc = YAML.parse(input) } catch (e) { return bad(`not valid YAML/JSON (${e instanceof Error ? e.message : String(e)})`) }
  }
  if (!isRecord(doc)) return bad('the document must be a map')

  const code = typeof doc.code === 'string' ? doc.code : bad('code is required')
  if (!CODE_RE.test(code)) return bad(`code must be lower-kebab (a-z, 0-9, -), got: ${code}`)
  const version = doc.version !== undefined ? scalarString(doc.version, 'version') : bad('version is required')

  const generated: Record<string, string> = {}
  if (doc.generated !== undefined) {
    if (!isRecord(doc.generated)) return bad('generated must be a map of name -> generator spec')
    for (const [name, spec] of Object.entries(doc.generated)) {
      if (!GENERATOR_NAME_RE.test(name)) return bad(`generated.${name}: generator names must be lower_snake (a-z, 0-9, _), starting with a letter`)
      const s = scalarString(spec, `generated.${name}`)
      if (!GENERATOR_RE.test(s)) return bad(`generated.${name}: unknown generator '${s}' (the daemon knows secret:N)`)
      generated[name] = s
    }
  }

  if (!isRecord(doc.services) || Object.keys(doc.services).length === 0) return bad('services must be a non-empty map')
  const services: Record<string, TemplateService> = {}
  for (const [name, rawSvc] of Object.entries(doc.services)) {
    const at = `services.${name}`
    if (!SERVICE_NAME_RE.test(name)) return bad(`${at}: service names must be lower-kebab (a-z, 0-9, -)`)
    if (!isRecord(rawSvc)) return bad(`${at} must be a map`)
    const type = rawSvc.type === 'web' || rawSvc.type === 'worker' || rawSvc.type === 'postgres'
      ? rawSvc.type : bad(`${at}.type must be web, worker or postgres`)
    // A managed postgres service is BARE: the daemon owns its image, port, sizing and credentials,
    // so a manifest has nothing to configure on it and anything it set would be silently ignored.
    // Refused with the field named.
    if (type === 'postgres') {
      for (const field of ['image', 'build', 'port', 'healthcheck', 'volume', 'volumeGib', 'spec', 'alwaysOn', 'command', 'mountPath'] as const) {
        if (rawSvc[field] !== undefined) return bad(`${at}.${field}: a postgres service is platform-managed and carries no ${field} (declare it bare: { type: postgres })`)
      }
      // env must be absent or an EXACT empty shell (known group names, each an empty map): the
      // shell so the normalized manifest round-trips losslessly, and EXACT so shapes like
      // `env: { fixed: "A=1" }` are refused rather than silently normalized away.
      if (rawSvc.env !== undefined) {
        const groups = ['fixed', 'generated', 'platform', 'required', 'optional']
        const emptyShell = isRecord(rawSvc.env)
          && Object.entries(rawSvc.env).every(([g, v]) => groups.includes(g) && isRecord(v) && Object.keys(v).length === 0)
        if (!emptyShell) return bad(`${at}.env: a postgres service is platform-managed and carries no env (declare it bare: { type: postgres })`)
      }
      services[name] = { type, env: { fixed: {}, generated: {}, platform: {}, required: {}, optional: {} } }
      continue
    }
    const image = rawSvc.image !== undefined ? scalarString(rawSvc.image, `${at}.image`) : undefined
    const build = rawSvc.build !== undefined ? scalarString(rawSvc.build, `${at}.build`) : undefined
    if (!image && !build) return bad(`${at}: one of image or build is required`)
    if (image && build) return bad(`${at}: image and build are mutually exclusive`)
    let port: number | undefined
    if (rawSvc.port !== undefined) {
      port = Number(rawSvc.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return bad(`${at}.port must be an integer port`)
    }
    const healthcheck = rawSvc.healthcheck !== undefined ? scalarString(rawSvc.healthcheck, `${at}.healthcheck`) : undefined
    // Stored rows still carry `spec`. Ignored, not refused, unless the manifest is AUTHORED here.
    if (opts?.rejectAuthoredSizing && rawSvc.spec !== undefined) {
      return bad(`${at}.spec: compute size is the daemon's to choose, remove this field`)
    }
    let alwaysOn: boolean | undefined
    if (rawSvc.alwaysOn !== undefined) {
      if (typeof rawSvc.alwaysOn !== 'boolean') return bad(`${at}.alwaysOn must be a boolean`)
      alwaysOn = rawSvc.alwaysOn
    }
    if (type === 'web' && !healthcheck) return bad(`${at}: web services must declare a healthcheck path`)
    if (healthcheck !== undefined) {
      if (!healthcheck.startsWith('/')) return bad(`${at}.healthcheck must be an absolute path (start with /)`)
      // The daemon FETCHES this path: it must be a path on the deployed service and nothing else.
      if (!HEALTHCHECK_RE.test(healthcheck)) {
        return bad(`${at}.healthcheck must be a single-slash absolute path on the service itself (no '//host', scheme, backslash, or control characters), got: ${healthcheck}`)
      }
    }
    // Three shapes, one meaning: `volume: true` (authored today) plus the sized pair stored rows
    // still carry. The size is read and DROPPED, so the daemon owns it retroactively too.
    let volume: boolean | undefined
    if (opts?.rejectAuthoredSizing && (isRecord(rawSvc.volume) || rawSvc.volumeGib !== undefined)) {
      return bad(`${at}.volume: the size is the daemon's to choose, declare \`volume: true\``)
    }
    if (rawSvc.volume !== undefined) {
      if (rawSvc.volume !== true && !isRecord(rawSvc.volume)) return bad(`${at}.volume must be true`)
      volume = true
    } else if (rawSvc.volumeGib !== undefined) {
      volume = true
    }
    let command: string | undefined
    if (rawSvc.command !== undefined) {
      command = scalarString(rawSvc.command, `${at}.command`).trim()
      if (!command) return bad(`${at}.command must be a non-empty string`)
    }
    let mountPath: string | undefined
    if (rawSvc.mountPath !== undefined) {
      if (!volume) return bad(`${at}.mountPath requires volume: true`)
      const raw = scalarString(rawSvc.mountPath, `${at}.mountPath`)
      if (!raw.trim()) return bad(`${at}.mountPath must be an absolute path`)
      try {
        mountPath = normalizeMountPath(raw)
      } catch (e) {
        // The validator names the field `mountPath` already, so only the location is prefixed.
        return bad(`${at}.${(e as Error).message}`)
      }
    }

    const rawEnv = rawSvc.env === undefined ? {} : rawSvc.env
    if (!isRecord(rawEnv)) return bad(`${at}.env must be a map`)
    const fixed: Record<string, string> = {}
    for (const [k, v] of Object.entries(parseEnvNames(rawEnv.fixed, `${at}.env.fixed`))) fixed[k] = scalarString(v, `${at}.env.fixed.${k}`)
    const generatedEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(parseEnvNames(rawEnv.generated, `${at}.env.generated`))) {
      const ref = scalarString(v, `${at}.env.generated.${k}`)
      const m = /^\$\{([a-zA-Z0-9_-]+)\}$/.exec(ref)
      if (!m) return bad(`${at}.env.generated.${k} must reference a declared generator like \${name}`)
      // Own-property, never `in`: 'toString'/'constructor' ride the prototype chain and would
      // otherwise pass as "declared".
      if (!Object.hasOwn(generated, m[1])) return bad(`${at}.env.generated.${k} references undeclared generator '${m[1]}'`)
      generatedEnv[k] = ref
    }
    const platform: Record<string, string> = {}
    for (const [k, v] of Object.entries(parseEnvNames(rawEnv.platform, `${at}.env.platform`))) {
      const ref = scalarString(v, `${at}.env.platform.${k}`)
      if (!PLATFORM_REF_RE.test(ref)) return bad(`${at}.env.platform.${k} must reference a platform credential like \${{services.<name>.<KEY>}}`)
      platform[k] = ref
    }
    const required: Record<string, TemplateVarSpec> = {}
    for (const [k, v] of Object.entries(parseEnvNames(rawEnv.required, `${at}.env.required`))) required[k] = parseVarSpec(v, `${at}.env.required.${k}`)
    const optional: Record<string, TemplateVarSpec> = {}
    for (const [k, v] of Object.entries(parseEnvNames(rawEnv.optional, `${at}.env.optional`))) optional[k] = parseVarSpec(v, `${at}.env.optional.${k}`)

    // An env name has exactly ONE source. A duplicate across groups either loses silently at
    // assembly (last group wins) or surfaces as a background bind/set conflict AFTER services
    // exist. Parse names the key and both groups instead.
    const groups: Array<[string, Record<string, unknown>]> = [['fixed', fixed], ['generated', generatedEnv], ['platform', platform], ['required', required], ['optional', optional]]
    const seen = new Map<string, string>()
    for (const [groupName, group] of groups) {
      for (const k of Object.keys(group)) {
        const prior = seen.get(k)
        if (prior) return bad(`${at}.env: '${k}' is declared in both ${prior} and ${groupName}, an env name may have exactly one source`)
        seen.set(k, groupName)
      }
    }

    services[name] = {
      type, image, build, port, healthcheck, volume, alwaysOn,
      ...(command !== undefined ? { command } : {}),
      ...(mountPath !== undefined ? { mountPath } : {}),
      env: { fixed, generated: generatedEnv, platform, required, optional },
    }
  }

  // env.platform refs are validated once ALL services are parsed (a web service may reference a
  // database declared after it): the target must exist, be a credential-minting type, and expose
  // the named canonical key, or the manifest could never bind at deploy.
  for (const [name, svc] of Object.entries(services)) {
    for (const [envName, ref] of Object.entries(svc.env.platform)) {
      const { service: target, key } = parsePlatformRef(ref)
      if (!Object.hasOwn(services, target)) return bad(`services.${name}.env.platform.${envName} references unknown service '${target}'`)
      const targetSvc = services[target]
      const allowed = CANONICAL_KEYS[targetSvc.type] ?? []
      if (!allowed.length) return bad(`services.${name}.env.platform.${envName}: service '${target}' (${targetSvc.type}) mints no platform credentials`)
      if (!allowed.includes(key)) return bad(`services.${name}.env.platform.${envName}: '${key}' is not a credential of a ${targetSvc.type} service (one of: ${allowed.join(', ')})`)
    }
  }

  const constraints: TemplateConstraint[] = []
  if (doc.constraints !== undefined) {
    if (!Array.isArray(doc.constraints)) return bad('constraints must be an array')
    // Constraint names must refer to DECLARED deploy-time variables: resolveVariables ignores
    // undeclared caller keys, so a constraint over an undeclared name could never be satisfied.
    const declared = new Set<string>()
    for (const svc of Object.values(services)) {
      for (const k of Object.keys(svc.env.required)) declared.add(k)
      for (const k of Object.keys(svc.env.optional)) declared.add(k)
    }
    for (const [i, raw] of doc.constraints.entries()) {
      if (!isRecord(raw)) return bad(`constraints[${i}] must be a map`)
      const c: TemplateConstraint = {}
      for (const kind of ['oneOf', 'allOf'] as const) {
        if (raw[kind] === undefined) continue
        if (!Array.isArray(raw[kind]) || !(raw[kind] as unknown[]).every((k) => typeof k === 'string')) {
          return bad(`constraints[${i}].${kind} must be an array of variable names`)
        }
        for (const varName of raw[kind] as string[]) {
          if (!declared.has(varName)) return bad(`constraints[${i}].${kind} references undeclared variable '${varName}', constraints may only name declared required/optional variables`)
        }
        c[kind] = raw[kind] as string[]
      }
      if (!c.oneOf && !c.allOf) return bad(`constraints[${i}] must carry oneOf or allOf`)
      constraints.push(c)
    }
  }

  // Every ${...} ref in env.fixed is validated HERE, after all services are parsed: one seam that
  // covers the catalog and inline deploys alike. A fixed value may reference SERVICE addresses
  // (url|host) only. GENERATOR refs are refused even when declared: a generator embedded in a
  // fixed string ends up stored only as the final composed value, which is not invertible, so a
  // retry could not recover it and would silently ROTATE a secret the first attempt already wrote.
  for (const [name, svc] of Object.entries(services)) {
    for (const [envName, value] of Object.entries(svc.env.fixed)) {
      for (const m of value.matchAll(/\$\{([^}]+)\}/g)) {
        const ref = m[1].trim()
        const at = `services.${name}.env.fixed.${envName}`
        // A ${{...}} platform-credential ref dropped into fixed shows up here with a leading '{'
        // (the inner brace): name the actual mistake instead of a baffling "undeclared generator".
        if (ref.startsWith('{')) {
          return bad(`${at}: platform credential refs (\${{services.<name>.<KEY>}}) belong under env.platform, not fixed`)
        }
        const svcRef = /^services\.([a-z0-9-]+)\.([a-zA-Z0-9_]+)$/.exec(ref)
        if (svcRef) {
          if (!Object.hasOwn(services, svcRef[1])) return bad(`${at} references unknown service '${svcRef[1]}' (\${${ref}})`)
          // A managed database runs no app: it has no url/host to resolve. Its credentials flow
          // through env.platform (${{services.<name>.<KEY>}}), never a URL ref.
          if (services[svcRef[1]].type === 'postgres') return bad(`${at}: service '${svcRef[1]}' is a managed postgres, it has no url/host; reference its credentials via env.platform (\${${ref}})`)
          if (svcRef[2] !== 'url' && svcRef[2] !== 'host') return bad(`${at}: '${svcRef[2]}' is not a resolvable service property (url or host) (\${${ref}})`)
          continue
        }
        if (Object.hasOwn(generated, ref)) {
          return bad(`${at}: generator refs are not allowed inside fixed values, declare ${envName} under env.generated instead (a generator embedded in a fixed string cannot be recovered on retry and would silently rotate)`)
        }
        return bad(`${at} references undeclared generator '${ref}' (\${${ref}})`)
      }
    }
  }

  // Catalog-facing metadata is VALIDATED, not cast: a manifest with meta.tags as a string would
  // otherwise pass and crash catalog filtering later, on a public route.
  let meta: TemplateMeta | undefined
  if (doc.meta !== undefined) {
    if (!isRecord(doc.meta)) return bad('meta must be a map')
    meta = { ...(doc.meta as Record<string, unknown>) } as TemplateMeta
    for (const key of ['name', 'tagline', 'category', 'logo'] as const) {
      if (doc.meta[key] !== undefined) meta[key] = scalarString(doc.meta[key], `meta.${key}`)
    }
    // A logo is read from the template's own directory and served on a PUBLIC route, so the path
    // is a relative name inside it, never an absolute path or a walk out of it.
    if (meta.logo !== undefined && meta.logo !== 'none') {
      const rel = meta.logo.replace(/^\.\//, '')
      if (/^([a-zA-Z]:)?[/\\]/.test(rel) || rel.split(/[/\\]/).includes('..')) {
        return bad('meta.logo must be a path inside the template directory')
      }
    }
    if (doc.meta.tags !== undefined) {
      if (!Array.isArray(doc.meta.tags)) return bad('meta.tags must be an array of strings')
      meta.tags = doc.meta.tags.map((t, i) => scalarString(t, `meta.tags[${i}]`))
    }
    if (doc.meta.draft !== undefined) {
      if (typeof doc.meta.draft !== 'boolean') return bad('meta.draft must be a boolean')
      meta.draft = doc.meta.draft
    }
    // Validated, never rewritten: the values are stored exactly as authored, so `manifestDigest`
    // is the same on both sides of the parser split (the platform spreads meta verbatim and does
    // not know this key yet). A misspelt architecture is refused rather than silently meaning
    // "runs nowhere", which is what an unrecognised name would amount to at deploy time.
    if (doc.meta.architectures !== undefined) {
      if (!Array.isArray(doc.meta.architectures) || doc.meta.architectures.length === 0) {
        return bad('meta.architectures must be a non-empty array of architecture names')
      }
      const arches = doc.meta.architectures.map((a, i) => scalarString(a, `meta.architectures[${i}]`))
      for (const a of arches) {
        if (!TEMPLATE_ARCHITECTURES.includes(a)) {
          return bad(`meta.architectures: '${a}' is not one of ${TEMPLATE_ARCHITECTURES.join(', ')}`)
        }
      }
      if (new Set(arches).size !== arches.length) return bad('meta.architectures lists the same architecture twice')
      meta.architectures = arches
    }
    // Links are served (documentation -> documentationUrl) and rendered as outbound anchors, so
    // EVERY value is held to the same absolute-https rule rather than only the one key the catalog
    // reads today.
    if (doc.meta.links !== undefined) {
      if (!isRecord(doc.meta.links)) return bad('meta.links must be a map of name -> URL')
      const links: Record<string, string> = {}
      for (const [linkName, value] of Object.entries(doc.meta.links)) {
        const problem = httpsUrlProblem(value)
        if (problem) return bad(`meta.links.${linkName} ${problem}`)
        links[linkName] = value as string
      }
      meta.links = links
    }
  }

  // The upstream pin passes through verbatim, but `license` is served as a typed catalog field, so
  // it is type-checked here rather than cast at serialization time on a public route.
  let upstream: TemplateUpstream | undefined
  if (isRecord(doc.upstream)) {
    upstream = { ...doc.upstream } as TemplateUpstream
    if (doc.upstream.license !== undefined) upstream.license = scalarString(doc.upstream.license, 'upstream.license')
  }

  return {
    code, version,
    maintainer: typeof doc.maintainer === 'string' ? doc.maintainer : undefined,
    sourceRepo: typeof doc.sourceRepo === 'string' ? doc.sourceRepo : undefined,
    upstream,
    generated, services, constraints, meta,
    variableOrder: variableOrderOf(doc.variableOrder, services),
  }
}

// Declared order on the way in; a stored array on the way back, when the key order is already gone.
function variableOrderOf(stored: unknown, services: Record<string, TemplateService>): string[] {
  const declared: string[] = []
  for (const svc of Object.values(services)) {
    for (const group of [svc.env.required, svc.env.optional]) {
      for (const name of Object.keys(group)) if (!declared.includes(name)) declared.push(name)
    }
  }
  if (!Array.isArray(stored)) return declared
  const kept = stored.filter((n): n is string => typeof n === 'string' && declared.includes(n))
  const unique = [...new Set(kept)]
  return [...unique, ...declared.filter((n) => !unique.includes(n))]
}

/** Byte cap on a README the catalog serves. The bundled ones run 2.3 to 5.2 KiB, so 128 KiB is
 *  ~25x the largest real one; oversize reads as absent rather than being truncated. */
export const TEMPLATE_README_MAX_BYTES = 128 * 1024

/** The architectures a manifest claims its images are published for, or `null` when it makes no
 *  claim. Null is not "both": a manifest that says nothing is not evidence, so the deploy path
 *  lets it through and the catalog reports the silence rather than inventing an answer. */
export function manifestArchitectures(manifest: TemplateManifest): string[] | null {
  const declared = manifest.meta?.architectures
  return Array.isArray(declared) && declared.length > 0 ? [...declared] : null
}

/** The manifest's deploy-time variables, merged into the global variable namespace. */
export function collectVariables(manifest: TemplateManifest): TemplateVariable[] {
  const byName = new Map<string, TemplateVariable>()
  for (const svc of Object.values(manifest.services)) {
    const groups: Array<[Record<string, TemplateVarSpec>, boolean]> = [[svc.env.required, true], [svc.env.optional, false]]
    for (const [group, required] of groups) {
      for (const [name, spec] of Object.entries(group)) {
        const prev = byName.get(name)
        byName.set(name, {
          name,
          description: prev?.description ?? spec.description,
          required: (prev?.required ?? false) || required,
          default: prev?.default ?? spec.default,
          generate: prev?.generate ?? spec.generate,
          editable: prev?.editable ?? spec.editable,
        })
      }
    }
  }
  // Declaration order; names the order omits keep their relative position, after the ones it names.
  const ordered: TemplateVariable[] = []
  for (const name of manifest.variableOrder) {
    const v = byName.get(name)
    if (!v) continue
    ordered.push(v)
    byName.delete(name)
  }
  return [...ordered, ...byName.values()]
}

/**
 * Content digest of a normalized manifest (key-order-independent), the identity an idempotent
 * retry is checked against: the same deploymentId re-invoked with a DIFFERENT manifest must 409
 * rather than silently redeploy under the old attribution record.
 */
export function manifestDigest(manifest: TemplateManifest): string {
  const canon = (v: unknown): unknown => Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
      : v
  // variableOrder is presentation, not identity: including it would 409 every in-flight retry the
  // moment an author reorders a form field.
  const identity: Record<string, unknown> = { ...manifest }
  delete identity.variableOrder
  return createHash('sha256').update(JSON.stringify(canon(identity))).digest('hex')
}

/** Which normalization produced a stored digest (contract section 4 `digestEpoch`). */
export const DIGEST_EPOCH = 2

/** Cryptographically random value for a generator spec (secret:N -> N base64url chars). */
export function generateValue(spec: string): string {
  const m = GENERATOR_RE.exec(spec)
  if (!m) throw new ManifestError(`unknown generator: ${spec}`)
  const n = Number(m[1])
  return randomBytes(n).toString('base64url').slice(0, n)
}

/**
 * Resolve every deploy-time variable to a value: caller-provided wins, then the declared
 * generator, then the default. Required variables left with nothing throw the machine-readable
 * MissingTemplateVariablesError; optional ones simply stay unset.
 */
export function resolveVariables(manifest: TemplateManifest, provided: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {}
  const missing: MissingVariable[] = []
  for (const v of collectVariables(manifest)) {
    const given = provided[v.name]
    if (given !== undefined && given !== '') { values[v.name] = given; continue }
    if (v.generate) { values[v.name] = generateValue(v.generate); continue }
    if (v.default !== undefined) { values[v.name] = v.default; continue }
    if (v.required) missing.push({ name: v.name, key: v.name, description: v.description })
  }
  if (missing.length) throw new MissingTemplateVariablesError(missing)
  return values
}

/**
 * Constraint check over the EFFECTIVE variable set (what resolveVariables produced: provided +
 * generated + defaults). Violations are author/user-actionable messages; empty = satisfied.
 */
export function constraintViolations(manifest: TemplateManifest, values: Record<string, string>): string[] {
  const has = (k: string): boolean => values[k] !== undefined && values[k] !== ''
  const violations: string[] = []
  for (const c of manifest.constraints) {
    if (c.oneOf && !c.oneOf.some(has)) violations.push(`at least one of ${c.oneOf.join(', ')} is required`)
    if (c.allOf && !c.allOf.every(has)) violations.push(`all of ${c.allOf.join(', ')} are required together`)
  }
  return violations
}

/**
 * Substitute ${...} references in a template string: `${<generator>}` -> its generated value,
 * `${services.<name>.host|url}` -> the named service's address (known before deploy: the router
 * hostname is minted at service create). Unknown references are an authoring error, surfaced
 * verbatim.
 */
export function resolveTemplateString(
  value: string,
  ctx: { generators: Record<string, string>; services: Record<string, { host: string; url: string }> },
): string {
  return value.replace(/\$\{([^}]+)\}/g, (_all, raw: string) => {
    const ref = raw.trim()
    const svc = /^services\.([a-z0-9-]+)\.(host|url)$/.exec(ref)
    if (svc) {
      if (!Object.hasOwn(ctx.services, svc[1])) throw new ManifestError(`env references unknown service '${svc[1]}' (\${${ref}})`)
      const target = ctx.services[svc[1]]
      return svc[2] === 'host' ? target.host : target.url
    }
    if (Object.hasOwn(ctx.generators, ref)) return ctx.generators[ref]
    throw new ManifestError(`env references undeclared generator '${ref}' (\${${ref}})`)
  })
}

/**
 * The final env map for one service: fixed (with service refs resolved) + generated refs +
 * required/optional variables that resolved to a value. This set, and only this set, is what the
 * executor writes authoritatively onto the service (replace, not merge).
 */
export function envForService(
  manifest: TemplateManifest,
  serviceName: string,
  ctx: { values: Record<string, string>; generators: Record<string, string>; services: Record<string, { host: string; url: string }> },
): Record<string, string> {
  const svc = manifest.services[serviceName]
  if (!svc) throw new ManifestError(`unknown service: ${serviceName}`)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(svc.env.fixed)) env[k] = resolveTemplateString(v, ctx)
  for (const [k, ref] of Object.entries(svc.env.generated)) env[k] = resolveTemplateString(ref, ctx)
  for (const group of [svc.env.required, svc.env.optional]) {
    for (const name of Object.keys(group)) {
      if (Object.hasOwn(ctx.values, name) && ctx.values[name] !== undefined) env[name] = ctx.values[name]
    }
  }
  return env
}

/**
 * The service names one service's env REFERENCES via `${services.<name>.host|url}` (fixed +
 * generated strings, the two groups resolveTemplateString resolves). Self-refs and cycles are
 * valid: an oss compute hostname is deterministic before the container exists.
 */
export function referencedServices(manifest: TemplateManifest, serviceName: string): string[] {
  const svc = manifest.services[serviceName]
  if (!svc) return []
  const out = new Set<string>()
  for (const v of [...Object.values(svc.env.fixed), ...Object.values(svc.env.generated)]) {
    for (const m of String(v).matchAll(/\$\{\s*services\.([a-z0-9-]+)\.(?:host|url)\s*\}/g)) out.add(m[1])
  }
  return [...out]
}

/** One env spec entry as recorded on the deployment record: secret REFS, never plaintext. */
export type EnvSpecEntry = { source: 'fixed' | 'generated' | 'platform' | 'required' | 'optional'; generator?: string; value?: string; ref?: string }

/**
 * The env map as recorded on the deployment record: secret REFS, never plaintext user/generated
 * secrets. Fixed values come from the manifest itself (already public), so they keep their value.
 */
export function envSpecForService(manifest: TemplateManifest, serviceName: string): Record<string, EnvSpecEntry> {
  const svc = manifest.services[serviceName]
  if (!svc) throw new ManifestError(`unknown service: ${serviceName}`)
  const out: Record<string, EnvSpecEntry> = {}
  for (const [k, v] of Object.entries(svc.env.fixed)) out[k] = { source: 'fixed', value: v }
  for (const [k, ref] of Object.entries(svc.env.generated)) out[k] = { source: 'generated', generator: ref.slice(2, -1) }
  // Platform credential renames are BINDINGS, not written values: the spec records the ref only.
  for (const [k, ref] of Object.entries(svc.env.platform)) {
    const { service, key } = parsePlatformRef(ref)
    out[k] = { source: 'platform', ref: `services.${service}.${key}` }
  }
  for (const k of Object.keys(svc.env.required)) out[k] = { source: 'required' }
  for (const k of Object.keys(svc.env.optional)) out[k] = { source: 'optional' }
  return out
}

// ---- failure-report log tail -------------------------------------------------------------------

/** How much container log rides a failure report: enough to see a crash loop, small enough for a row. */
export const LOG_TAIL_LINES = 40
/** Byte cap on the stored tail. Truncated from the HEAD: a crash's last words are at the end, and
 *  the marker spends from the same budget so the stored tail never exceeds the cap. */
export const LOG_TAIL_MAX_BYTES = 4096
const LOG_TAIL_TRUNCATION_MARKER = '… (truncated)\n'

/**
 * Mask every secret this run wrote before a log tail is PERSISTED. App logs leak credentials by
 * accident (dumped env, echoed headers) and the daemon must not be the thing that copies one into
 * a durable row. Values of 6 chars or more mask as a plain substring (a long random value embeds
 * anywhere); shorter ones mask by alphanumeric-boundary token, because substring-masking "1" or
 * "dev" would shred the log for no protection. Best-effort hygiene, not a guarantee.
 */
export function redactLogTail(text: string, secrets: string[]): string {
  let out = text
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const s of [...new Set(secrets)].filter((v) => v.length > 0).sort((a, b) => b.length - a.length)) {
    if (s.length >= 6) out = out.split(s).join('[redacted]')
    else out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escape(s)}(?![A-Za-z0-9])`, 'g'), '[redacted]')
  }
  return out
    .replace(/(bearer\s+)[a-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/\bsk-[a-z0-9_-]{16,}\b/gi, 'sk-[redacted]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[redacted]')
}

/** Cap a redacted tail at LOG_TAIL_MAX_BYTES, keeping the END (where a crash's reason is). */
export function capLogTail(tail: string): string {
  const buf = Buffer.from(tail, 'utf8')
  if (buf.length <= LOG_TAIL_MAX_BYTES) return tail
  const budget = LOG_TAIL_MAX_BYTES - Buffer.byteLength(LOG_TAIL_TRUNCATION_MARKER, 'utf8')
  const start = buf.length - budget
  return `${LOG_TAIL_TRUNCATION_MARKER}${buf.subarray(start).toString('utf8')}`
}

// Ported from the platform's volume-path.ts: same rules, same messages.
const RESERVED_MOUNTS = ['/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/libx32', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var']
function normalizeMountPath(value: string): string {
  const path = value.trim()
  if (path.length > 255) throw new Error('mountPath must be at most 255 characters')
  if (!path.startsWith('/')) throw new Error('mountPath must be an absolute path')
  if (!/^[a-zA-Z0-9._/\-]+$/.test(path)) throw new Error("mountPath may contain only letters, digits, '.', '-', '_' and '/'")
  if (path.split('/').includes('..')) throw new Error('mountPath must not contain ..')
  const clean = posix.normalize(path).replace(/\/$/, '') || '/'
  if (RESERVED_MOUNTS.includes(clean) || ['/dev', '/proc', '/sys', '/.insta'].some((p) => clean === p || clean.startsWith(p + '/'))) {
    throw new Error('mountPath is reserved by the container runtime')
  }
  return clean
}
