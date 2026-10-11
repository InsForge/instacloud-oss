// The template executor: the platform's own orchestration (insta-platform
// src/provisioning/templates.ts at 9f0c0d3) over the daemon's existing doors. It creates services
// through the engine's `services add`, writes variables through user secrets and bindings, deploys
// through the engine's deploy path, then polls the manifest healthcheck. It provisions nothing
// itself.
//
// Steps, in this exact order (the step keys are the CLI progress watcher's vocabulary):
//   parse manifest (synchronous, before the 202)
//   -> create_services -> write_variables -> deploy -> health_check
//
// The POST answers 202 as soon as the record exists; everything that talks to docker runs in the
// background and is observable by polling GET /template-deployments/:id. Failure KEEPS what it
// created: half a template is debuggable, a rolled-back one is gone. Re-invoking with the same
// deploymentId resumes instead of duplicating services.
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { PG_VERSION, type Engine } from '../engine'
import { hostArch } from '../hostarch'
import { BRANCH_NAME_RE, SERVICE_NAME_RE } from '../names'
import { loadState, mutate } from '../state'
import { parseServiceId } from '../manageddb'
import type { GatedAction, TemplateDeploymentRecord } from '../types'
import { TemplateCatalog, TemplateNotFoundError } from './catalog'
import {
  capLogTail, constraintViolations, DIGEST_EPOCH, envForService, envSpecForService,
  generateValue, manifestArchitectures, manifestDigest, ManifestError,
  MissingTemplateVariablesError, parsePlatformRef, parseTemplateManifest, redactLogTail,
  referencedServices, resolveVariables, LOG_TAIL_LINES, type TemplateManifest,
} from './manifest'

/** A 'running' record younger than this belongs to a live run and answers a poll instead of
 *  restarting; an older one was stranded by a hard kill and may be retried. */
const RUN_LEASE_MS = 10 * 60 * 1000
/** How many independent copies of one template one branch will hold. Deploying again mints
 *  `<name>-2`, `<name>-3` ... rather than taking the previous copy over. */
const MAX_TEMPLATE_COPIES = 9
const MINTED_NAME_MAX = 39
/** The same cap, for the branch name a template copy mints. */
const BRANCH_NAME_MAX = 39
/** The one grammar, not a fourth copy of it. A local pattern here allowed the trailing hyphen
 *  `src/names.ts` rejects; nothing that reaches this check can end in one today (the parser
 *  validates the base and the suffix is '' or '-2'...'-N'), but the comment at the call site
 *  claims the parser applied the same rule, and importing it is what makes that true. */
const MINTED_NAME_RE = SERVICE_NAME_RE
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** What `abandonStale()` writes onto a run the daemon killed. `catalog.stats` excludes rows whose
 *  error starts with this text: a restart says nothing about the template. */
export const RESTART_ABANDONED = 'the daemon restarted while the template deployment was running - retry with the same deploymentId to resume'

/** What a deployment row carries INSTEAD of a log tail when the run could not build a complete
 *  redaction list. It is what the operator reads, so it says what to do next. */
const WITHHELD_TAIL = '(log tail withheld: this run could not read every secret it wrote, so it cannot show that the tail is redacted. Read the container logs directly with `insta logs`.)'

/** Thrown by a gate callback that has already answered the request (403 or 202). */
export class GateRefused extends Error {
  constructor() { super('template deploy refused by policy'); this.name = 'GateRefused' }
}
/** A 4xx the route maps by `status`. */
export class TemplateError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'TemplateError' }
}

export type TemplateDeployInput = {
  templateCode?: string
  templateVersion?: string
  manifest?: unknown        // inline YAML string or JSON document (local-manifest deploys)
  branchId?: string
  branch?: string           // branch NAME, accepted as an alias
  variables?: Record<string, string>
  deploymentId?: string     // idempotent retry: resume THIS deployment instead of starting another
}

/** What `GET /template-deployments/:id` serves (the cloud's TemplateDeployment schema). */
export type TemplateDeploymentView = {
  id: string
  status: string
  step: string
  templateCode: string
  templateVersion: string
  projectId: string
  branchId: string
  services: Array<{ name: string; serviceId?: string; url?: string; state?: string }>
  error?: string
  logsTail?: string
  createdAt: string
}

type Rec = TemplateDeploymentRecord
type Entry = Rec['services'][string]

export interface TemplateExecutorOpts {
  /** Injected by tests. The default loops back into the router's own HTTP lane (decision 58). */
  httpProbe?: (url: string, headers: Record<string, string>) => Promise<number>
}

export class TemplateExecutor {
  private inFlight = new Set<Promise<void>>()

  constructor(private readonly engine: Engine, private readonly opts: TemplateExecutorOpts = {}) {}

  private get catalog(): TemplateCatalog {
    return this.engine.templates
  }

  /** Await every background run (tests; also the shutdown path). */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight])
  }

  /** At boot: a `running` record cannot have a live executor behind it any more. */
  abandonStale(): string[] {
    const stale = Object.values(loadState().templateDeployments ?? {}).filter((r) => r.status === 'running')
    for (const r of stale) this.finish(r.id, 'failed', RESTART_ABANDONED, null, r.claimToken)
    return stale.map((r) => r.id)
  }

  /** The governance gates this deploy must clear, in order. */
  gatesFor(manifest: TemplateManifest): GatedAction[] {
    const gates: GatedAction[] = ['service.add', 'secrets.write', 'deploy']
    // A manifest declaring a volume asks for the disk at creation, which the volume routes gate
    // under service.upgrade. Kept because it fails CLOSED: narrowing a governance gate is its own
    // change, not a side effect of this one.
    if (Object.values(manifest.services).some((svc) => svc.volume === true)) gates.push('service.upgrade')
    return gates
  }

  // ---- accept (synchronous, before the 202) ------------------------------------------------------

  async create(projectId: string, input: TemplateDeployInput, gate?: (actions: GatedAction[]) => Promise<void>): Promise<{ deployment: TemplateDeploymentView }> {
    const project = this.engine.getProject(projectId)
    if (!project) throw new TemplateError(404, 'project not found')
    if (input.deploymentId && !UUID_RE.test(input.deploymentId)) throw new TemplateError(400, 'deploymentId must be a UUID')

    // A RETRY resends the manifest its first attempt was accepted with, so authored-sizing
    // strictness applies to FRESH deploys only.
    const existing = input.deploymentId ? this.record(input.deploymentId) : undefined
    if (existing && existing.projectId !== projectId) throw new TemplateError(404, 'template deployment not found')
    const retrying = existing !== undefined

    const manifest = this.resolveManifest(input, { authored: !retrying })
    this.assertExecutable(manifest)
    const deploymentId = input.deploymentId ?? randomUUID()
    const digest = manifestDigest(manifest)
    const claimToken = randomUUID()

    // Idempotency FIRST, before variable validation and before branch resolution: a retry must be
    // FOR THE SAME DEPLOYMENT (same code, version and manifest content), or a pasted-wrong id would
    // deploy different content under the old attribution record.
    if (existing) {
      const stored = existing.digestEpoch === DIGEST_EPOCH ? existing.manifestDigest : undefined
      if (existing.templateCode !== manifest.code || existing.templateVersion !== manifest.version || (stored !== undefined && stored !== digest)) {
        throw new TemplateError(409,
          `deployment ${deploymentId} was created for ${existing.templateCode}@${existing.templateVersion} with a different manifest - a retry must resend the same manifest; start a NEW deployment for a changed one`)
      }
      if (existing.status === 'succeeded') return { deployment: this.view(existing) }
      if (existing.status === 'running' && Date.now() - Date.parse(existing.updatedAt) < RUN_LEASE_MS) {
        // A live run is already doing this exact work: the caller gets the record to poll.
        return { deployment: this.view(existing) }
      }
    }

    // GOVERNANCE here and not at the route: every echo above returned already, so a policy change
    // cannot retroactively refuse a finished deployment and an echo never consumes a single-use
    // approval. From this line on the run WILL perform the gated actions.
    if (gate) await gate(this.gatesFor(manifest))

    // The branch: the record's own on a retry, then branchId/branch, else a fresh one named after
    // the template. Resolved BEFORE the variable check, so a missing branch answers 404 rather than
    // missing_variables.
    const branch = await this.resolveBranch(projectId, input, existing, manifest.code)

    // Variables gate only what genuinely needs them: a NEW run, or a resume for values the first
    // attempt never wrote. A resume recovers from the secrets it already wrote (which also keeps a
    // generated password stable across retries instead of silently rotating it).
    const provided = { ...(input.variables ?? {}) }
    let recoveredGenerators: Record<string, string> = {}
    if (existing) {
      const recovered = this.recoverStoredVariables(manifest, existing, projectId, branch.name)
      for (const [k, v] of Object.entries(recovered.values)) if (provided[k] === undefined || provided[k] === '') provided[k] = v
      recoveredGenerators = recovered.generators
    }
    const values = resolveVariables(manifest, provided)
    const violations = constraintViolations(manifest, values)
    if (violations.length) throw new TemplateError(400, `template constraints not satisfied: ${violations.join('; ')}`)

    const services = await this.initialSpec(manifest, existing, projectId, branch.name)
    await this.assertQuota(manifest, projectId, branch.name, services)

    const now = new Date().toISOString()
    const record: Rec = {
      id: deploymentId, projectId, branchId: branch.id,
      templateCode: manifest.code, templateVersion: manifest.version, templateSource: manifest.maintainer ?? 'official',
      status: 'running', step: 'create_services',
      services, manifestDigest: digest, digestEpoch: DIGEST_EPOCH, claimToken,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    }
    mutate((s) => { (s.templateDeployments ??= {})[deploymentId] = record })
    this.engine.emit(projectId, branch.name, 'resource', 'template.deploy', {
      deploymentId, template: `${manifest.code}@${manifest.version}`,
    })

    const done = this.run(record, manifest, values, recoveredGenerators, branch.name)
    this.inFlight.add(done)
    void done.catch(() => { /* the record carries the reason */ }).finally(() => this.inFlight.delete(done))
    return { deployment: this.view(this.record(deploymentId) ?? record) }
  }

  /** GET /template-deployments/:id (looked up globally, like the cloud). */
  get(deploymentId: string): TemplateDeploymentView {
    const row = this.record(deploymentId)
    if (!row) throw new TemplateError(404, 'template deployment not found')
    return this.view(row)
  }

  // ---- accept helpers ---------------------------------------------------------------------------

  private record(id: string): Rec | undefined {
    return loadState().templateDeployments?.[id]
  }

  private resolveManifest(input: TemplateDeployInput, opts: { authored: boolean }): TemplateManifest {
    // Inline = authored, so it gets the strict refusal, unless this is a retry resending what was
    // already accepted. Only the by-code path reads the bundled catalog.
    if (input.manifest !== undefined) return parseTemplateManifest(input.manifest, { rejectAuthoredSizing: opts.authored })
    const code = input.templateCode
    if (!code) throw new TemplateError(400, 'one of manifest or templateCode is required')
    const entry = this.catalog.find(code)
    if (!entry || entry.draft) throw new TemplateError(404, `template not found: ${code}`)
    if (input.templateVersion && input.templateVersion !== entry.manifest.version) {
      throw new TemplateError(404, `template version not found: ${code}@${input.templateVersion} (the registry serves ${entry.manifest.version})`)
    }
    return entry.manifest
  }

  /** What this executor can run: image WEB services, plus bare managed-postgres services. */
  private assertExecutable(manifest: TemplateManifest): void {
    for (const [name, svc] of Object.entries(manifest.services)) {
      if (svc.build) throw new TemplateError(400, `services.${name} uses build: - template deploys support image services only (build-based templates are deployed via their published image)`)
      if (svc.type === 'worker') throw new TemplateError(400, `services.${name} is a worker - template deploys support web services only in v1 (a portless worker path is a follow-up)`)
      if (svc.command !== undefined) throw new TemplateError(400, `services.${name}.command is cloud-only today: the self-hosted runtime runs the image's own command`)
      if (svc.mountPath !== undefined) throw new TemplateError(400, `services.${name}.mountPath is cloud-only today: the self-hosted runtime mounts volumes at /data`)
      if (svc.type === 'storage') throw new TemplateError(400, `services.${name} is a storage service, which is cloud-only today: the self-hosted runtime does not create template buckets yet`)
      if (svc.pgVersion !== undefined && svc.pgVersion !== PG_VERSION) throw new TemplateError(400, `services.${name}.pgVersion ${svc.pgVersion} is cloud-only today: the self-hosted runtime runs Postgres ${PG_VERSION} only`)
    }
    // Architecture, here rather than at the pull. A template whose image is published for one
    // architecture only fails on an arm64 box with docker's `no matching manifest for
    // linux/arm64/v8`, and it fails in the BACKGROUND, in the deploy step, after the services and
    // secrets exist: a failed run keeps what it created, so the operator is left tidying up a
    // half-template to learn something the manifest already knew. Refused synchronously instead,
    // before the 202, with the two architectures named.
    const arches = manifestArchitectures(manifest)
    const host = hostArch()
    if (arches && !arches.includes(host)) {
      throw new TemplateError(400,
        `${manifest.code}@${manifest.version} publishes ${arches.join(' and ')} images only, and this machine is ${host}: `
        + `its image has no ${host} manifest to pull. Run the template on ${arches.join(' or ')} hardware, or, if you have `
        + `emulation set up and accept the speed, deploy the image yourself with 'insta deploy --image <ref>'.`)
    }
  }

  private async resolveBranch(projectId: string, input: TemplateDeployInput, existing: Rec | undefined, code: string): Promise<{ id: string; name: string }> {
    if (existing) {
      const recorded = loadState().branches[existing.branchId]
      if (!recorded || recorded.projectId !== projectId) throw new TemplateError(404, 'the branch this deployment targeted no longer exists')
      return { id: recorded.id, name: recorded.name }
    }
    if (input.branchId) {
      const b = loadState().branches[input.branchId]
      if (!b || b.projectId !== projectId) throw new TemplateError(404, 'branch not found')
      return { id: b.id, name: b.name }
    }
    if (input.branch) {
      const b = this.engine.getBranchByName(projectId, input.branch)
      if (!b) throw new TemplateError(404, `branch not found: ${input.branch}`)
      return { id: b.id, name: b.name }
    }
    // A FRESH branch named after the template, forked off the default branch. Synchronous: a fork
    // is a reflink copy here, not a provider round trip (decision 47).
    const branches = this.engine.listBranches(projectId)
    const parent = branches.find((b) => b.isDefault) ?? branches[0]
    if (!parent) throw new TemplateError(400, 'project has no branches')
    let name: string | null = null
    let overlong: string | null = null
    for (let i = 1; i <= MAX_TEMPLATE_COPIES; i++) {
      const candidate = i === 1 ? code : `${code}-${i}`
      if (this.engine.getBranchByName(projectId, candidate)) continue
      // The SUFFIX can push a legal code past the branch-name cap: a 38- or 39-character code is
      // valid, `code-2` is 40 or 41 and `createBranch` refuses it. Caught here, synchronously and
      // named for what actually happened, rather than reaching `assertBranchName` and surfacing as
      // "branch name must be lower-kebab" — a rule the user's code did not break. Governance has
      // already run by this point, so the vague 400 could also consume a single-use approval.
      // Mirrors the service-name copy path below, which has always refused this the same way.
      if (!BRANCH_NAME_RE.test(candidate)) { overlong = candidate; break }
      name = candidate
      break
    }
    if (overlong) {
      throw new TemplateError(409,
        `template ${code} is already on a branch and its code is too long to copy - `
        + `'${overlong}' exceeds the ${BRANCH_NAME_MAX}-character branch-name limit. `
        + 'Pass branchId explicitly, or shorten the template code')
    }
    if (!name) throw new TemplateError(409, `no free branch name for template ${code} - pass branchId explicitly`)
    const created = await this.engine.createBranch(projectId, name, parent.name)
    return { id: created.id, name: created.name }
  }

  /** The values a previous attempt already wrote, read back from the secrets it wrote them into
   *  (the record stores REFS only). Two kinds ride along: declared variables, keyed by their own
   *  env names, and top-level GENERATED values, keyed by the env names that reference them, so a
   *  resume neither demands a re-send nor rotates a token running services already hold. */
  private recoverStoredVariables(manifest: TemplateManifest, previous: Rec, projectId: string, branchName: string): { values: Record<string, string>; generators: Record<string, string> } {
    const values: Record<string, string> = {}
    const generators: Record<string, string> = {}
    for (const [name, svc] of Object.entries(manifest.services)) {
      const entry = previous.services[name]
      if (!entry?.serviceId || !entry.serviceName) continue
      const varNames = [...Object.keys(svc.env.required), ...Object.keys(svc.env.optional)]
      const generatedRefs = Object.entries(svc.env.generated)
      if (!varNames.length && !generatedRefs.length) continue
      const bundle = this.engine.boundSecrets(projectId, branchName, `compute/${entry.serviceName}`)
      for (const k of varNames) if (values[k] === undefined && bundle[k] !== undefined) values[k] = bundle[k]
      for (const [envName, ref] of generatedRefs) {
        const gen = ref.slice(2, -1)
        if (generators[gen] === undefined && bundle[envName] !== undefined) generators[gen] = bundle[envName]
      }
    }
    return { values, generators }
  }

  /** The per-service progress record, with the names this run will use minted free on the branch. */
  private async initialSpec(manifest: TemplateManifest, previous: Rec | undefined, projectId: string, branchName: string): Promise<Rec['services']> {
    const out: Rec['services'] = {}
    for (const [name, svc] of Object.entries(manifest.services)) {
      const prev = previous?.services[name]
      out[name] = {
        serviceName: prev?.serviceName ?? name,
        ...(prev?.serviceId ? { serviceId: prev.serviceId } : {}),
        type: svc.type === 'postgres' ? 'postgres' : 'web',
        ...(svc.image !== undefined ? { image: svc.image } : {}),
        ...(svc.type === 'postgres' ? {} : { port: svc.port ?? 8080 }),
        ...(svc.healthcheck !== undefined ? { healthcheck: svc.healthcheck } : {}),
        ...(svc.healthcheckTimeout !== undefined ? { healthcheckTimeout: svc.healthcheckTimeout } : {}),
        ...(prev?.volumeGib !== undefined ? { volumeGib: prev.volumeGib } : svc.volume ? { volumeGib: this.engine.cfg.templates.volumeGib } : {}),
        ...(svc.alwaysOn !== undefined ? { alwaysOn: svc.alwaysOn } : {}),
        env: prev?.env ?? {},
        state: 'pending',
      }
    }
    await this.mintServiceNames(manifest, projectId, branchName, out)
    return out
  }

  /** Give every service a name that is FREE on the branch. Deploying a template twice mints
   *  `<name>-2` beside the first copy instead of taking it over, and the suffix is chosen for the
   *  GROUP, so a two-service template lands as `n8n-2` + `db-2`, never `n8n-2` + `db`. A retry
   *  keeps the names its first attempt recorded: re-minting would strand what it created. */
  private async mintServiceNames(manifest: TemplateManifest, projectId: string, branchName: string, spec: Rec['services']): Promise<void> {
    const entries = Object.entries(manifest.services)
    if (entries.some(([name]) => spec[name].serviceId)) return
    const rows = await this.engine.services(projectId, branchName)
    const taken = new Set(rows.map((r) => `${r.type === 'compute' ? 'compute' : r.type}/${r.name}`))
    for (let n = 1; n <= MAX_TEMPLATE_COPIES; n++) {
      const suffix = n === 1 ? '' : `-${n}`
      const candidate = entries.map(([name, svc]) => [name, `${name}${suffix}`, svc.type === 'postgres' ? 'postgres' : 'compute'] as const)
      // A suffix can push a long manifest name past the service-name grammar, which `services add`
      // enforces INSIDE the background run: a 202 that fails minutes later. The first rung is
      // always legal (the parser applied the same rule), so this can only fire from the second, and
      // no longer suffix will fit either. Refuse here, synchronously.
      const overlong = candidate.find(([, platformName]) => !MINTED_NAME_RE.test(platformName))
      if (overlong) {
        throw new TemplateError(409,
          `service ${overlong[0]} is already on branch ${branchName} and its name is too long to copy - `
          + `'${overlong[1]}' exceeds the ${MINTED_NAME_MAX}-character limit. Deploy to another branch, or shorten the template's service name`)
      }
      if (candidate.some(([, platformName, type]) => taken.has(`${type}/${platformName}`))) continue
      for (const [name, platformName] of candidate) spec[name].serviceName = platformName
      return
    }
    throw new TemplateError(409, `branch ${branchName} already has ${MAX_TEMPLATE_COPIES} copies of ${manifest.code} - delete one, or deploy to another branch`)
  }

  /** The WHOLE plan against the per-type cap, at accept: the background create loop would otherwise
   *  202 an over-quota manifest, create a prefix of its services and fail asynchronously. */
  private async assertQuota(manifest: TemplateManifest, projectId: string, branchName: string, spec: Rec['services']): Promise<void> {
    const rows = await this.engine.services(projectId, branchName)
    const have = (type: string): number => rows.filter((r) => r.type === type).length
    const additions: Record<string, number> = {}
    for (const [name, svc] of Object.entries(manifest.services)) {
      const type = svc.type === 'postgres' ? 'postgres' : 'compute'
      // Only a service this deployment has not already created counts, and only while its row is
      // still there: deleting it between attempts makes the retry create it again, and skipping it
      // here would turn a synchronous 400 into a 202 that fails in the background.
      if (spec[name].serviceId && rows.some((r) => r.type === type && r.name === spec[name].serviceName)) continue
      additions[type] = (additions[type] ?? 0) + 1
    }
    const cap = this.engine.cfg.services.maxPerType
    for (const [type, add] of Object.entries(additions)) {
      if (have(type) + add > cap) {
        throw new TemplateError(400, `branch has reached this plan's limit of ${cap} ${type} services (INSTA_OSS_MAX_SERVICES_PER_TYPE)`)
      }
    }
  }

  // ---- the background run -----------------------------------------------------------------------

  private async run(record: Rec, manifest: TemplateManifest, values: Record<string, string>, recoveredGenerators: Record<string, string>, branchName: string): Promise<void> {
    const id = record.id
    const projectId = record.projectId
    const spec = record.services
    const save = (step?: Rec['step']): void => {
      mutate((s) => {
        const row = s.templateDeployments?.[id]
        if (!row || row.claimToken !== record.claimToken) return
        row.services = spec
        if (step) row.step = step
        row.updatedAt = new Date().toISOString()
      })
    }
    try {
      // -- create services (no image yet: a container must not run before its variables exist) --
      save('create_services')
      for (const [name, svc] of Object.entries(manifest.services)) {
        const entry = spec[name]
        const platformName = entry.serviceName
        const rows = await this.engine.services(projectId, branchName)
        const wanted = svc.type === 'postgres' ? 'postgres' : 'compute'
        const existingRow = rows.find((r) => r.type === wanted && r.name === platformName)
        if (entry.serviceId && existingRow) {
          // Already created by an earlier attempt of THIS deployment: reuse it.
        } else if (existingRow) {
          // Reuse by (type, name) only when this deployment owns it; anything else took the name
          // between accept and now, which is a hard conflict rather than a takeover.
          if (existingRow.template_deployment_id !== id) {
            throw new TemplateError(409, `service ${platformName} on branch ${branchName} was claimed by another owner while this deployment was starting - retry it`)
          }
          // The BARE id: a services() row id is branch-qualified off the default branch, and this
          // record is read back by every later step (and by the catalog's live check).
          entry.serviceId = parseServiceId(existingRow.id)?.serviceId ?? existingRow.id
        } else if (svc.type === 'postgres') {
          // On the deployment's OWN branch: services are branch-scoped, so without this a template
          // deployed to a branch would put its database on the default branch instead.
          const row = await this.engine.addDbService(projectId, platformName, { templateDeploymentId: id, branch: branchName })
          entry.serviceId = row.id
        } else {
          const row = this.engine.addComputeService(projectId, platformName, entry.volumeGib, {
            ...(svc.alwaysOn !== undefined ? { alwaysOn: svc.alwaysOn } : {}),
            ...(entry.port !== undefined ? { port: entry.port } : {}),
            templateDeploymentId: id, templateCode: manifest.code,
          })
          entry.serviceId = row.id
        }
        entry.state = 'created'
        save()
      }

      // -- generators + cross-service refs + variables (authoritative replace, never merge) --
      save('write_variables')
      const generators: Record<string, string> = {}
      for (const [name, genSpec] of Object.entries(manifest.generated)) {
        // A resume reuses the value the first attempt wrote: regenerating would silently rotate a
        // token running services were already handed.
        generators[name] = Object.hasOwn(recoveredGenerators, name) ? recoveredGenerators[name] : generateValue(genSpec)
      }
      const project = this.engine.getProject(projectId)!
      const branchRow = this.engine.getBranchByName(projectId, branchName)!
      const serviceRefs: Record<string, { host: string; url: string }> = {}
      for (const [name, svc] of Object.entries(manifest.services)) {
        if (svc.type === 'postgres') continue
        // An oss compute hostname is deterministic before the container exists (the router mints
        // it from the branch ref), so self-refs and cycles resolve with no placeholder machine.
        const url = this.engine.serviceUrl(project, branchRow, spec[name].serviceName)
        serviceRefs[name] = { host: new URL(url).hostname, url }
      }
      for (const [name] of Object.entries(manifest.services)) {
        for (const ref of referencedServices(manifest, name)) {
          if (!Object.hasOwn(serviceRefs, ref)) {
            throw new TemplateError(400, `compute service '${ref}' cannot expose a URL before deploy`)
          }
        }
      }
      // Everything this run writes as a secret: the redaction list for any log tail it captures.
      const writtenSecrets = [...Object.values(values), ...Object.values(generators)]
      // A read that could not answer is not "there were no credentials to mask". This catch used
      // to swallow the failure and carry on with a SHORT list, and the tail is then persisted on
      // the deployment row and served by `GET /template-deployments/:id` with a database password
      // in it. Same rule as everywhere else, applied to a confidentiality decision: no evidence
      // is not evidence, so the run remembers that it cannot prove a tail is clean and withholds
      // the tail rather than publishing one it could not fully redact.
      let redactable = true
      for (const [name, svc] of Object.entries(manifest.services)) {
        if (svc.type !== 'postgres' || !spec[name].serviceId) continue
        try {
          const creds = this.engine.credentials(projectId, spec[name].serviceId!, branchName)
          for (const v of Object.values(creds)) writtenSecrets.push(v)
        } catch (e) {
          redactable = false
          console.warn(`template deployment ${id}: could not read ${name}'s credentials to build the redaction list (${reasonOf(e)}); log tails are withheld for this run`)
        }
      }
      for (const [name, svc] of Object.entries(manifest.services)) {
        if (svc.type === 'postgres') continue                     // the database's env is the daemon's
        this.writeServiceEnv(projectId, branchName, manifest, name, spec, { values, generators, services: serviceRefs })
      }
      save()

      // -- deploy (attribution is already on every row, stamped at creation) --
      save('deploy')
      // Databases first: an app booting against a database that is not connectable yet crash-loops
      // through its own health gate for the database's fault.
      for (const [name, entry] of Object.entries(spec)) {
        if (entry.type !== 'postgres') continue
        const verdict = await this.awaitDbReady(projectId, branchName, entry)
        if (!verdict.ready) {
          entry.state = 'failed'
          save()
          this.finish(id, 'failed', `${name}: ${verdict.reason}`, null, record.claimToken)
          return
        }
        entry.state = 'healthy'
        save()
      }
      // Deploy order is manifest order; every URL ref was resolved above.
      for (const [name, entry] of Object.entries(spec)) {
        if (entry.type === 'postgres') continue
        try {
          const out = await this.engine.deploy(projectId, branchName, { image: entry.image!, port: entry.port, group: entry.serviceName })
          entry.url = out.url
          entry.state = 'deployed'
        } catch (e) {
          entry.state = 'failed'
          const tail = await this.captureLogTail(projectId, branchName, entry.serviceName, writtenSecrets, redactable)
          save()
          const live = Object.values(spec).filter((x) => x.state === 'deployed' || x.state === 'healthy').length
          this.finish(id, live > 0 ? 'partial' : 'failed', `${name}: ${reasonOf(e)}`, tail, record.claimToken)
          return
        }
        save()
      }

      // -- poll healthy; a miss captures the container log tail and fails the run --
      save('health_check')
      const failures: string[] = []
      let logTail: string | null = null
      for (const [name, entry] of Object.entries(spec)) {
        if (entry.type === 'postgres') continue                   // gated to healthy before the deploys
        const verdict = await this.awaitHealthy(projectId, branchName, entry)
        if (verdict.healthy) { entry.state = 'healthy'; continue }
        entry.state = 'failed'
        failures.push(`${name}: ${verdict.reason}`)
        logTail ??= await this.captureLogTail(projectId, branchName, entry.serviceName, writtenSecrets, redactable)
      }
      save()
      if (failures.length) {
        const healthy = Object.values(spec).filter((x) => x.state === 'healthy').length
        this.finish(id, healthy > 0 ? 'partial' : 'failed', failures.join('; '), logTail, record.claimToken)
        return
      }
      this.finish(id, 'succeeded', null, null, record.claimToken)
    } catch (e) {
      const deployed = Object.values(spec).filter((x) => x.state === 'deployed' || x.state === 'healthy').length
      try { save() } catch { /* best-effort */ }
      this.finish(id, deployed > 0 ? 'partial' : 'failed', reasonOf(e), null, record.claimToken)
      throw e
    }
  }

  /**
   * Resolve and authoritatively write ONE service's env: fixed/generated/variable values as user
   * secrets, env.platform as bindings, replacing what the previous attempt recorded.
   *
   * Replace, not merge, and staleness keys off the EFFECTIVE sets by SOURCE rather than the
   * declared names: a declared-but-unprovided optional is NOT written this run, so its old secret
   * must go or it would keep being injected forever; and a name whose SOURCE flips (written secret
   * to binding) must lose its old representation BEFORE the new one lands. User secrets outside the
   * manifest are never touched.
   */
  private writeServiceEnv(
    projectId: string, branchName: string, manifest: TemplateManifest, name: string, spec: Rec['services'],
    ctx: { values: Record<string, string>; generators: Record<string, string>; services: Record<string, { host: string; url: string }> },
  ): void {
    const svc = manifest.services[name]
    const entry = spec[name]
    const env = envForService(manifest, name, ctx)
    const newSpec = envSpecForService(manifest, name)
    const platformNames = new Set(Object.keys(svc.env.platform))
    // The PLATFORM name, not the manifest key: this copy may be `n8n-2`, and writing to
    // `compute/<manifest key>` would put its variables into the FIRST copy's service.
    const target = `compute/${entry.serviceName}`
    for (const [n, e] of Object.entries(entry.env)) {
      if (e.source !== 'platform' && !(n in env)) this.engine.unsetUserSecret(projectId, n, branchName, target)
      if (e.source === 'platform' && !platformNames.has(n)) this.engine.unsetBinding(projectId, branchName, n, target)
    }
    for (const [k, v] of Object.entries(env)) this.engine.setUserSecret(projectId, k, v, branchName, target)
    for (const [envName, ref] of Object.entries(svc.env.platform)) {
      const parsed = parsePlatformRef(ref)
      const sourceType = manifest.services[parsed.service].type === 'postgres' ? 'postgres' : 'compute'
      this.engine.setBinding(projectId, branchName, {
        envName, target,
        // Both sides are PLATFORM names: the services addressed here may carry a `-2` suffix.
        source: `${sourceType}/${spec[parsed.service]?.serviceName ?? parsed.service}`,
        sourceName: parsed.key,
      })
    }
    entry.env = newSpec
  }

  /** `claimToken` is the run's claim on the row, exactly as `save()` uses it: a run stranded past
   *  the lease must not mark a fresh re-run of the same deployment failed while it is still creating
   *  services. `abandonStale` passes the row's own token, which is what makes it a takeover. */
  private finish(id: string, status: 'succeeded' | 'failed' | 'partial', error: string | null, logTail: string | null, claimToken?: string): void {
    const row = this.record(id)
    if (claimToken !== undefined && row?.claimToken !== claimToken) return
    mutate((s) => {
      const r = s.templateDeployments?.[id]
      if (!r) return
      if (claimToken !== undefined && r.claimToken !== claimToken) return
      r.status = status
      if (error) r.error = error
      if (logTail !== null) r.logsTail = logTail
      r.updatedAt = new Date().toISOString()
    })
    if (!row) return
    this.engine.emit(row.projectId, this.branchNameOf(row), 'resource',
      status === 'succeeded' ? 'template.deploy.succeeded' : 'template.deploy.failed',
      { deploymentId: id, template: `${row.templateCode}@${row.templateVersion}`, status, ...(error ? { reason: error } : {}) })
  }

  private branchNameOf(row: Rec): string | null {
    return loadState().branches[row.branchId]?.name ?? null
  }

  // ---- health gates -----------------------------------------------------------------------------

  /** A managed postgres is ready once its container EXISTS and docker says so. Two statuses
   *  prove that: `healthy` (running) and `standby` (created, then paused or slept -- the resting
   *  state a scale-to-zero database is provisioned into, which the lane wakes on the first
   *  connection). Nothing else is evidence.
   *
   *  `none` and `unknown` used to pass, on the reasoning that the adapter had just returned from
   *  provisioning so a docker read that cannot see the container is a reading problem. That is
   *  the rule this codebase applies everywhere else INVERTED: `runtimeHealth` reports `unknown`
   *  precisely when docker could not answer and `none` when the container is genuinely absent,
   *  and a probe that cannot answer is not evidence of health. Accepting them let a
   *  database-only template finish `succeeded` without ever proving its database exists, and a
   *  mixed template start deploying apps against a database that may not be there. Both now
   *  POLL, exactly as `starting` does, and fail at the health deadline with the last status they
   *  saw. `crashed` is still terminal, because it is a definite answer. */
  private async awaitDbReady(projectId: string, branchName: string, entry: Entry): Promise<{ ready: boolean; reason?: string }> {
    const deadline = Date.now() + this.engine.cfg.templates.healthTimeoutMs
    let last = 'unknown'
    for (;;) {
      try {
        const health = await this.engine.runtimeHealth(projectId, branchName)
        const row = health.services.find((r) => r.serviceId === entry.serviceId)
        last = row?.status ?? 'unknown'
        if (last === 'crashed') return { ready: false, reason: 'the database container crashed' }
        if (last === 'healthy' || last === 'standby') return { ready: true }
      } catch { /* transient docker read: keep polling */ }
      if (Date.now() >= deadline) return { ready: false, reason: `not ready within ${Math.round(this.engine.cfg.templates.healthTimeoutMs / 1000)}s (last status: ${last})` }
      await sleep(this.engine.cfg.templates.healthPollMs)
    }
  }

  /** The machine gate, then the MANIFEST healthcheck: the machine-level check only proves a
   *  container is running, and an app that boots but serves 500s on its declared /healthz is a real
   *  failure the manifest field exists to catch. */
  private async awaitHealthy(projectId: string, branchName: string, entry: Entry): Promise<{ healthy: boolean; reason?: string }> {
    const cfg = this.engine.cfg
    // The manifest's own number when it declared one, so a template that knows it is quick fails
    // fast and one with migrations to run is not cut off at the shared default.
    const timeout = entry.healthcheckTimeout !== undefined ? entry.healthcheckTimeout * 1000 : cfg.templates.healthTimeoutMs
    const deadline = Date.now() + timeout
    const probe = this.opts.httpProbe ?? defaultHttpProbe(cfg.port)
    let last = 'unknown'
    let machineUp = false
    for (;;) {
      if (!machineUp) {
        try {
          const st = await this.engine.serviceState(projectId, `cp-${entry.serviceName}`, branchName)
          last = st.state
          if (st.state === 'running' || st.state === 'suspended') machineUp = true
          else if (st.state === 'stopped' && st.desiredState === 'running') return { healthy: false, reason: 'the service crashed (its container exited against a running intent)' }
        } catch { /* transient read: keep polling */ }
      }
      if (machineUp) {
        if (!entry.healthcheck || !entry.url) return { healthy: true }
        // Belt to the parse-time grammar's suspenders (SSRF): the resolved URL must still sit on
        // the DEPLOYED SERVICE's own origin, or the manifest is pointing our fetch elsewhere.
        let target: URL
        try {
          target = new URL(entry.healthcheck, entry.url)
          if (target.origin !== new URL(entry.url).origin) {
            return { healthy: false, reason: `the declared healthcheck path resolves off the service origin (${target.origin}) - refusing to probe it` }
          }
        } catch {
          return { healthy: false, reason: `the declared healthcheck path is not a valid path on the service URL: ${entry.healthcheck}` }
        }
        try {
          const status = await probe(target.toString(), { Host: target.host, 'X-Forwarded-Proto': target.protocol === 'https:' ? 'https' : 'http' })
          last = `HTTP ${status} on ${entry.healthcheck}`
          // 401 and 403 count as healthy: the browser terminals serve ttyd behind basic auth, so
          // GET / answers 401 and requiring 2xx would report a usable deployment as failed. A 404
          // stays unhealthy (the declared path does not exist, i.e. the MANIFEST is wrong) and so
          // does a redirect (`redirect: manual`, so a hop is observed, never followed).
          if ((status >= 200 && status < 300) || status === 401 || status === 403) return { healthy: true }
        } catch { /* unreachable yet (cold start): keep polling */ }
      }
      if (Date.now() >= deadline) return { healthy: false, reason: `not healthy within ${Math.round(timeout / 1000)}s (last status: ${last})` }
      await sleep(cfg.templates.healthPollMs)
    }
  }

  /** The failing container's last lines, with every secret this run wrote masked -- or nothing at
   *  all when the run could not enumerate what it wrote. The tail is durable (it goes on the
   *  deployment row and out of the API), so publishing one built from a list known to be short is
   *  a disclosure, and "we could not read the credentials" is exactly when the list is short. */
  private async captureLogTail(projectId: string, branchName: string, group: string, secrets: string[], redactable = true): Promise<string | null> {
    if (!redactable) return WITHHELD_TAIL
    try {
      const out = await this.engine.runtimeLogs(projectId, { component: 'compute', branchName, group, limit: LOG_TAIL_LINES })
      const text = out.lines.map((l) => `${l.ts} ${l.message}`).join('\n')
      if (!text.trim()) return null
      return capLogTail(redactLogTail(text, secrets))
    } catch { return null }
  }

  // ---- view -------------------------------------------------------------------------------------

  private view(row: Rec): TemplateDeploymentView {
    return {
      id: row.id,
      status: row.status,
      step: row.step,
      templateCode: row.templateCode,
      templateVersion: row.templateVersion,
      projectId: row.projectId,
      branchId: row.branchId,
      // The name the service ACTUALLY has, not the manifest key: they diverge for every copy after
      // the first, and a client resolving this name against the branch would otherwise land on the
      // first, unrelated instance.
      services: Object.entries(row.services).map(([name, s]) => ({
        name: s.serviceName ?? name,
        ...(s.serviceId ? { serviceId: s.serviceId } : {}),
        ...(s.url ? { url: s.url } : {}),
        state: s.state,
      })),
      ...(row.error ? { error: row.error } : {}),
      ...(row.logsTail ? { logsTail: row.logsTail } : {}),
      createdAt: row.createdAt,
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The default health probe: ONE request to the daemon's own HTTP port carrying the service's Host
 * header, which is the router's HTTP lane (decision 58). It never resolves the public name (which
 * on a NAT'd or sslip.io box may not point back at this machine) and never speaks TLS (with an
 * internal CA, Node would reject the edge's certificate and every deploy would fail here).
 * Redirects are not followed: a healthcheck that redirects is not a 2xx.
 */
function defaultHttpProbe(port: number): (url: string, headers: Record<string, string>) => Promise<number> {
  return (url, headers) => new Promise<number>((resolve, reject) => {
    const u = new URL(url)
    const req = httpRequest({
      host: '127.0.0.1', port, method: 'GET', path: `${u.pathname}${u.search}`, headers,
      timeout: 5000,
    }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('timeout', () => req.destroy(new Error('probe timeout')))
    req.on('error', reject)
    req.end()
  })
}

/** A manifest or executor error carries its own message; anything else is an internal failure. */
function reasonOf(e: unknown): string {
  if (e instanceof TemplateError || e instanceof ManifestError || e instanceof TemplateNotFoundError) return e.message
  if (e instanceof MissingTemplateVariablesError) return e.message
  const m = e instanceof Error ? e.message : String(e)
  return m ? `internal template deployment failure: ${m}` : 'internal template deployment failure'
}
