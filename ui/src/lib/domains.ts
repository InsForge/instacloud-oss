// Custom-domain envelope helpers over the cloud's compute/domain routes (contract decision 25:
// no `ssl` key; certificate presence is folded into `configured`).

export type DnsStatus = 'ok' | 'missing' | 'mismatch' | 'unchecked'

export interface DnsRecord {
  type: string
  name: string
  value: string
  note?: string
  status?: DnsStatus | string
}

export interface DomainResult {
  hostname: string
  flyApp?: string
  configured?: boolean
  /** `pending | ready | not added` from the daemon; the cloud may also say `error`. */
  status?: string
  dns?: DnsRecord[]
  service?: string
  region?: string
  errorReason?: string
}

export type DomainStage = 'active' | 'verifying' | 'needs-records' | 'error'

export function domainStage(r: DomainResult): DomainStage {
  if (r.status === 'error' || r.errorReason) return 'error'
  if (r.configured && r.status === 'ready') return 'active'
  if (!r.configured && (r.dns ?? []).some((d) => d.status === 'ok')) return 'verifying'
  return 'needs-records'
}

export const STAGE_LABEL: Record<DomainStage, string> = {
  active: 'Active',
  verifying: 'Verifying',
  'needs-records': 'Needs DNS records',
  error: 'Error',
}

export function stageHint(r: DomainResult): string {
  switch (domainStage(r)) {
    case 'active': return 'Serving over HTTPS.'
    case 'verifying': return 'Records found. The certificate is being issued; click Verify to re-check.'
    case 'error': return r.errorReason ?? 'The edge reported an error for this hostname.'
    default: return 'Create the DNS records below at your DNS provider, then click Verify.'
  }
}

/** The cloud's hostname rule: dotted lower-case labels, a letters-only TLD, 253 chars max. */
export const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/

/** Lower-case, strip a scheme, path, query, port and trailing dot; the result is what gets
 *  validated by HOSTNAME_RE and sent as `hostname`. */
export function normalizeHostInput(raw: string): string {
  let s = raw.trim().toLowerCase()
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  s = s.replace(/[/?#].*$/, '')
  s = s.replace(/:\d+$/, '')
  s = s.replace(/\.+$/, '')
  return s
}
