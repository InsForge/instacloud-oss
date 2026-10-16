// The console's service list (insta-frontend services/service-table.tsx): card rows under a bare
// label row, each row its own bordered card with an alpha-4 hover wash. Self-host divergence: no
// Region column (one node), and no attachment rail rows yet.

import { useState } from 'react'
import { Button, cn } from '@insforge/ui'
import type { RuntimeHealthRow, Service } from '../../api'
import { usePoll } from '../../hooks'
import { api } from '../../api'
import { deriveStatus, healthFor } from '../../lib/status'
import type { PendingApproval } from '../ApprovalPrompt'
import { TemplateLogo } from '../ui'
import { ServiceActionsMenu } from './ServiceActionsMenu'
import { ServiceTypeIcon } from './ServiceIcon'
import { ServiceStatusIndicator } from './ServiceStatus'

/** The wash is a pseudo layer under the row's content (the caller's `relative isolate` keeps the
 *  -z-10 inside the row), so the card fill underneath survives the hover (console row-hover.ts). */
const ROW_HOVER = "cursor-pointer after:pointer-events-none after:absolute after:inset-0 after:-z-10 after:content-[''] hover:after:bg-alpha-4"

export function serviceRowClass(): string {
  return cn('relative isolate flex items-center gap-6 border border-border bg-card pr-4', ROW_HOVER)
}

/** "Sep 10, 2026": the console's Created column is a date, not a time. */
export function createdDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** A template-deployed compute service wears its template's logo, as on the console. */
function ServiceMark({ service, logos }: { service: Service; logos: Map<string, string | null> }) {
  const logo = service.type === 'compute' && service.template_code ? logos.get(service.template_code) : undefined
  if (logo) return <TemplateLogo src={logo} name={service.name} className="size-6 bg-transparent p-0" />
  return <ServiceTypeIcon type={service.type} className="size-6" />
}

export function ServiceTable({ projectId, branch, services, health, isWaking, onOpen, onDone, onError, onApproval }: {
  projectId: string; branch: string; services: Service[]; health?: RuntimeHealthRow[]
  isWaking: (id: string) => boolean; onOpen: (service: Service) => void
  onDone: () => void; onError: (message: string) => void; onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  // The bundled catalog, for template logos; it changes only with the daemon.
  const { data: templates } = usePoll(api.templates, [], 300_000)
  const logos = new Map((templates ?? []).map((t) => [t.code, t.logoUrl]))

  return (
    <div className="flex flex-col gap-2">
      {/* The label row's box matches a data row exactly (same border, padding, gap and trailing
          kebab-sized spacer), or every column after the first drifts. */}
      <div className="flex items-center gap-6 border border-transparent bg-alpha-4 py-3 pr-4 text-[13px] leading-[18px] text-muted-foreground">
        <span className="min-w-0 flex-2"><span className="ml-4">Service</span></span>
        <span className="max-w-60 min-w-0 flex-1">Status</span>
        <span className="max-w-30 min-w-0 flex-1">Created</span>
        <span className="w-7 shrink-0" aria-hidden="true" />
      </div>
      {services.map((service) => (
        // A div with onClick is unreachable by keyboard: button semantics and Enter/Space make the
        // row an actual control. Key events from the nested actions menu are ignored, or Enter on
        // "Delete Service" would also open the row behind the dialog.
        <div key={service.id} role="button" tabIndex={0} aria-label={`Open ${service.name}`}
          onClick={() => onOpen(service)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(service) }
          }}
          className={serviceRowClass()}>
          <div className="flex min-w-0 flex-2 items-center gap-1 self-stretch">
            <span className="w-7 shrink-0" aria-hidden="true" />
            <span className="flex size-14 shrink-0 items-center justify-center">
              <ServiceMark service={service} logos={logos} />
            </span>
            <span className="truncate text-sm">{service.name}</span>
          </div>
          <div className="max-w-60 min-w-0 flex-1" onClick={(e) => e.stopPropagation()}>
            <RowStatus projectId={projectId} branch={branch} service={service}
              status={deriveStatus(service, healthFor(health, service.id), isWaking(service.id))}
              onWoke={onDone} onError={onError} onApproval={onApproval} />
          </div>
          <div className="max-w-30 min-w-0 flex-1 truncate text-sm">{createdDate(service.created_at ?? service.updated_at)}</div>
          <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
            <ServiceActionsMenu projectId={projectId} branch={branch} service={service} onDone={onDone} onError={onError}
              onApproval={onApproval} iconClassName="size-5 text-disabled" />
          </span>
        </div>
      ))}
    </div>
  )
}

/** Status, plus the Wake affordance for a sleeping service.
 *
 *  The old list carried a Wake button and this console-parity table dropped it, so a sleeping
 *  service could only be started by opening its detail view first. Waking is exactly what you want
 *  from the list, and deriveStatus already says which states allow it. */
function RowStatus({ projectId, branch, service, status, onWoke, onError, onApproval }: {
  projectId: string; branch: string; service: Service
  status: ReturnType<typeof deriveStatus>
  onWoke: () => void; onError: (m: string) => void; onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const [busy, setBusy] = useState(false)
  const wake = async () => {
    setBusy(true)
    const r = await api.lifecycle(projectId, service.id, 'start', branch)
    setBusy(false)
    if (r.kind === 'error') return onError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void wake() } })
    onWoke()
  }
  return (
    <div className="flex items-center gap-2">
      <ServiceStatusIndicator status={status} />
      {status.wakeable && (
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => { void wake() }}>
          {busy ? 'Waking…' : 'Wake'}
        </Button>
      )}
    </div>
  )
}
