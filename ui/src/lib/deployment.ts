// Template-deployment progress rules (plan 07 H.6), pure so the four-step ladder and the
// per-service list are unit-tested. The daemon serves the cloud's TemplateDeployment view: an
// array of services; a record keyed by service name (the stored form) is accepted too.

export const DEPLOY_STEPS = ['create_services', 'write_variables', 'deploy', 'health_check'] as const
export type DeployStep = (typeof DEPLOY_STEPS)[number]
export const STEP_LABEL: Record<DeployStep, string> = {
  create_services: 'Create services',
  write_variables: 'Write variables',
  deploy: 'Deploy',
  health_check: 'Health check',
}

export type StepMark = 'done' | 'active' | 'pending' | 'failed'
export type DeploymentServiceState = 'pending' | 'created' | 'deployed' | 'healthy' | 'failed'
export interface DeploymentService { name: string; serviceId?: string; url?: string; state: DeploymentServiceState }

export const TERMINAL = new Set(['succeeded', 'failed', 'partial'])
export const POLL_MS = 2000
export const MAX_WAIT_MS = 15 * 60_000

export function isTerminal(status: string | undefined): boolean {
  return !!status && TERMINAL.has(status)
}

/** Marks for the four steps: everything before the current step is done, the current one is
 *  active (or failed when the run ended without success), later ones pending; a succeeded run
 *  marks all four done. */
export function stepMarks(status: string | undefined, step: string | undefined): StepMark[] {
  if (status === 'succeeded') return DEPLOY_STEPS.map(() => 'done')
  const idx = DEPLOY_STEPS.indexOf(step as DeployStep)
  return DEPLOY_STEPS.map((_, i) => {
    if (idx === -1) return status && isTerminal(status) ? 'failed' : 'pending'
    if (i < idx) return 'done'
    if (i === idx) return status === 'failed' || status === 'partial' ? 'failed' : 'active'
    return 'pending'
  })
}

/** Normalise the services field: the cloud view is an array with `name`; the stored record form
 *  is keyed by service name with `serviceName` inside. */
export function normalizeServices(services: unknown): DeploymentService[] {
  const one = (name: string, v: unknown): DeploymentService | null => {
    if (!v || typeof v !== 'object') return null
    const o = v as { name?: unknown; serviceName?: unknown; serviceId?: unknown; url?: unknown; state?: unknown }
    const n = typeof o.name === 'string' && o.name ? o.name : typeof o.serviceName === 'string' && o.serviceName ? o.serviceName : name
    if (!n) return null
    const state = (['pending', 'created', 'deployed', 'healthy', 'failed'] as const).find((s) => s === o.state) ?? 'pending'
    return {
      name: n,
      serviceId: typeof o.serviceId === 'string' ? o.serviceId : undefined,
      url: typeof o.url === 'string' && o.url ? o.url : undefined,
      state,
    }
  }
  if (Array.isArray(services)) return services.map((s) => one('', s)).filter((s): s is DeploymentService => !!s)
  if (services && typeof services === 'object') {
    return Object.entries(services as Record<string, unknown>).map(([k, v]) => one(k, v)).filter((s): s is DeploymentService => !!s)
  }
  return []
}

/** The single URL to offer as `Open service`, when exactly one service has one. */
export function soleUrl(services: DeploymentService[]): string | undefined {
  const urls = services.map((s) => s.url).filter((u): u is string => !!u)
  return urls.length === 1 ? urls[0] : undefined
}

/** Human line for the footer of the progress view. */
export function statusLine(status: string | undefined): string {
  switch (status) {
    case 'succeeded': return 'Deployed.'
    case 'failed': return 'Deployment failed.'
    case 'partial': return 'Partially deployed; some services failed.'
    case 'running': return 'Deploying...'
    default: return ''
  }
}
