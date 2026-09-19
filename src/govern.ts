// HITL circuit breaker — same semantics as the platform: gate sensitive actions at the
// credential boundary. decision ∈ allow|deny|approve; grants are one-shot (consumed per gate);
// `approve --always` flips the project policy to allow. Defaults: every action → allow, which is
// the cloud's posture since platform #267 (project.delete, service.remove and db.restore were all
// flipped from approve): governance is opt-in per project, from the dashboard's policy matrix or
// `PUT /projects/:id/policy/:action` (the CLI retired its `policy` command, here and on the cloud).
// A default of approve here made a plain `insta project delete` stop at "approval required" on
// this daemon while the same command simply worked on the cloud.
import { randomUUID } from 'node:crypto'
import { mutate, loadState } from './state'
import type { Approval, Decision, GatedAction } from './types'
import { GATED_ACTIONS } from './types'

const DEFAULTS: Record<GatedAction, Decision> = {
  'secrets.read': 'allow',
  'secrets.write': 'allow',
  // Separate from secrets.* so file browsing/writes/removal can each be gated on their own —
  // same split (and same allow defaults) as the platform.
  'storage.read': 'allow',
  'storage.write': 'allow',
  'storage.delete': 'allow',
  // The data browsers: reads of user data (the redis key browser) and the SQL editor's arbitrary
  // statements. Separate actions so a project can gate the editor while keeping reads open.
  'db.read': 'allow',
  'db.query': 'allow',
  deploy: 'allow',
  'project.delete': 'allow',
  'branch.delete': 'allow',
  'service.add': 'allow',
  'service.remove': 'allow',
  'service.setAccess': 'allow',
  'service.rename': 'allow',
  // Cloud gates PUT limits (and a template deploy that declares a volume) on it; WP3 adds the routes.
  'service.upgrade': 'allow',
}

export type GateResult =
  | { decision: 'allow' }
  | { decision: 'deny' }
  | { decision: 'approval_required'; approvalId: string }

export function effectivePolicy(projectId: string): Record<GatedAction, Decision> {
  const overrides = loadState().policies[projectId] ?? {}
  return Object.fromEntries(GATED_ACTIONS.map((a) => [a, overrides[a] ?? DEFAULTS[a]])) as Record<GatedAction, Decision>
}

export function setPolicy(projectId: string, action: GatedAction, decision: Decision): void {
  mutate((s) => { (s.policies[projectId] ??= {})[action] = decision })
}

/** Gate an action: allow → proceed; deny → blocked; approve → consume a grant or mint a pending approval. */
export function gate(projectId: string, action: GatedAction): GateResult {
  const decision = effectivePolicy(projectId)[action]
  if (decision === 'allow') return { decision: 'allow' }
  if (decision === 'deny') return { decision: 'deny' }
  return mutate((s) => {
    const granted = s.approvals.find((a) => a.projectId === projectId && a.action === action && a.status === 'granted')
    if (granted) { granted.status = 'consumed'; return { decision: 'allow' } }
    const approval: Approval = {
      id: randomUUID(), projectId, action, status: 'pending',
      requestedAt: new Date().toISOString(), decidedAt: null,
    }
    s.approvals.push(approval)
    return { decision: 'approval_required', approvalId: approval.id }
  })
}

export function listApprovals(projectId: string, status?: string): Approval[] {
  return loadState().approvals.filter((a) => a.projectId === projectId && (!status || a.status === status))
}

export function decide(projectId: string, approvalId: string, verdict: 'granted' | 'denied', always = false): Approval | null {
  return mutate((s) => {
    const a = s.approvals.find((x) => x.id === approvalId && x.projectId === projectId)
    if (!a || a.status !== 'pending') return null
    a.status = verdict
    a.decidedAt = new Date().toISOString()
    if (verdict === 'granted' && always) (s.policies[projectId] ??= {})[a.action] = 'allow'
    return a
  })
}
