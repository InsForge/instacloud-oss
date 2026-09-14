// The Service page, ported from the console (insta-frontend services/service-view.tsx): the Canvas /
// List toggle, Add Service in the corner, and the dashed empty-state CTA that opens the "Add Your
// Service" picker. Canvas is the default, as on the console, and an explicit List choice is the only
// thing stored. Canvas mode is full-bleed; the toggle and Add Service float at the same spots in both
// views, so switching never moves them.
//
// Self-host divergences: no agent-connect panel on the empty state; the canvas's own divergences are in
// components/console/ServiceCanvas.tsx.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { cn, Switch } from '@insforge/ui'
import { Rows3, Workflow } from 'lucide-react'
import { api, type Service } from '../api'
import { usePoll, useWaking } from '../hooks'
import { useLocalPref } from '../lib/localPref'
import { afterLoad, loadSecretTree, pollsTree, treeFor } from '../lib/secretTreeLoad'
import { linksFromSecretTree } from '../lib/serviceLinks'
import { healthFor } from '../lib/status'
import { ApprovalPrompt, type PendingApproval } from '../components/ApprovalPrompt'
import { AddFirstServiceDialog, AddServiceButton } from '../components/console/AddService'
import { ServiceCanvas } from '../components/console/ServiceCanvas'
import { ServiceTable } from '../components/console/ServiceTable'
import { ServiceDetailModal } from '../components/console/ServiceDetailModal'
import { ErrorNote } from '../components/ui'

/** User-level preference (not per project): how the service list is drawn. The console's key. */
const VIEW_MODE_KEY = 'insta-services-view'

/** Always-on for compute and managed rows: `PUT /services/:sid/always-on {enabled}`. */
export function AlwaysOnSwitch({ projectId, branch, service, onDone, onError, onApproval }: {
  projectId: string; branch: string; service: Service; onDone: () => void
  onError: (m: string) => void; onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const [busy, setBusy] = useState(false)
  const set = async (enabled: boolean) => {
    setBusy(true)
    const r = await api.setAlwaysOn(projectId, service.id, enabled, branch)
    setBusy(false)
    if (r.kind === 'error') return onError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => set(enabled) })
    onDone()
  }
  return (
    <Switch checked={!!service.always_on} disabled={busy} onCheckedChange={set}
      aria-label={`Always on for ${service.name}`} onClick={(e) => e.stopPropagation()} />
  )
}

/** Postgres has no always-on column: the same intent is scale-to-zero, inverted (decision 48). */
export function PgAlwaysOnSwitch({ projectId, branch, group, onError, onApproval }: {
  projectId: string; branch: string; group: string
  onError: (m: string) => void; onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const { data, reload } = usePoll(() => api.dbInstance(projectId, branch, group), [projectId, branch, group], 15000)
  const [busy, setBusy] = useState(false)
  const set = async (checked: boolean) => {
    setBusy(true)
    const r = await api.dbSettings(projectId, branch, { scaleToZero: !checked }, group)
    setBusy(false)
    if (r.kind === 'error') return onError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => set(checked) })
    reload()
  }
  return (
    <Switch checked={data ? !data.scaleToZero : false} disabled={busy || !data} onCheckedChange={set}
      aria-label={`Always on for ${group}`} onClick={(e) => e.stopPropagation()} />
  )
}

export function Services() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  // The detail overlay is URL-driven (`?service=<id>&tab=`), as on the console: deep links,
  // refresh and the back button all open and close it.
  const [params, setParams] = useSearchParams()
  const openId = params.get('service')
  const closeDetail = useCallback(() => setParams({}), [setParams])
  const openService = useCallback((s: Service) => setParams({ service: s.id }), [setParams])
  const waking = useWaking()
  const interval = waking.anyWaking ? 2000 : 5000
  const { data: services, error, reload } = usePoll(() => api.services(projectId, branch), [projectId, branch], interval)
  const { data: health } = usePoll(() => api.runtimeHealth(projectId, branch), [projectId, branch], interval)
  const [storedMode, setStoredMode] = useLocalPref(VIEW_MODE_KEY)
  const mode: 'canvas' | 'list' = storedMode === 'list' ? 'list' : 'canvas'
  // The canvas's edges, so only the canvas polls for them, on the console's cadence for bindings. A
  // member without secrets.read gets an approval or a refusal instead of a tree: a canvas with no edges,
  // and no further asks this visit, since each governed read mints an approval (secretTreeLoad.ts).
  // Gated projects only accumulate: reads finish out of order, and a stale one must never un-gate the
  // project shown now (secretTreeLoad.ts).
  const [gated, setGated] = useState<ReadonlySet<string>>(() => new Set())
  const { data: treeLoad } = usePoll(async () => {
    const load = await loadSecretTree(api.secretTreeResult, projectId)
    setGated((prev) => afterLoad(prev, load))
    return load
  }, [projectId], { intervalMs: 30_000, enabled: pollsTree(gated, projectId, mode) })
  const secretTree = treeFor(treeLoad, projectId)
  const [approval, setApproval] = useState<PendingApproval>(null)
  const [actionError, setActionError] = useState<string>()
  const [addFirstOpen, setAddFirstOpen] = useState(false)

  useEffect(() => { waking.reconcile(health, healthFor) }, [health, waking])

  const rows = services ?? []
  const empty = services !== undefined && rows.length === 0
  const links = useMemo(() => linksFromSecretTree(secretTree, branch, rows), [secretTree, branch, rows])
  const flow = { projectId, branch, services: rows, onDone: reload, onApproval: setApproval }

  // Squared segmented toggle: 36px card-surface buttons in a hairline-bordered group, equal-width
  // halves, the active one an inner box on the page surface, 13px label beside a 20px icon.
  const toggle = (
    <div className="grid grid-cols-2 border border-border bg-card">
      {([{ value: 'canvas', label: 'Canvas', icon: Workflow }, { value: 'list', label: 'List', icon: Rows3 }] as const).map(({ value, label, icon: Icon }) => (
        <button key={value} type="button" title={`${label} view`} aria-pressed={mode === value}
          onClick={() => setStoredMode(value === 'list' ? 'list' : null)}
          className={cn('group flex h-9 w-28 cursor-pointer items-center justify-center px-0.5', mode === value ? 'text-foreground' : 'text-muted-foreground')}>
          <span className={cn('flex w-full items-center justify-center gap-1 p-1.5 text-[13px] leading-[18px] transition-colors', mode === value ? 'bg-page' : 'group-hover:bg-alpha-4')}>
            <Icon className="size-5" />
            {label}
          </span>
        </button>
      ))}
    </div>
  )
  const floating = (
    <>
      <div className="absolute top-6 left-1/2 z-10 -translate-x-1/2">{toggle}</div>
      <div className="absolute top-6 right-6 z-10"><AddServiceButton {...flow} /></div>
    </>
  )
  const overlays = (
    <>
      <AddFirstServiceDialog {...flow} open={addFirstOpen} onOpenChange={setAddFirstOpen} />
      {openId && (
        <ServiceDetailModal projectId={projectId} branch={branch} serviceId={openId} requestedTab={params.get('tab')}
          onClose={closeDetail} />
      )}
      <ApprovalPrompt projectId={projectId} pending={approval} onClose={() => setApproval(null)} />
    </>
  )

  if (mode === 'canvas') {
    // Full-bleed: the canvas fills <main> (the positioned ancestor), escaping its padding, and the
    // toggle and Add Service float inside it at a 24px inset.
    return (
      <div className="absolute inset-0 min-h-[420px]">
        <ServiceCanvas projectId={projectId} branch={branch} services={rows} links={links} health={health}
          isWaking={waking.isWaking} onOpen={openService}
          onAddFirstService={empty ? () => setAddFirstOpen(true) : undefined}
          onDone={reload} onError={setActionError} onApproval={setApproval} />
        {floating}
        {(actionError || error) && <div className="absolute bottom-6 left-6 z-10"><ErrorNote error={actionError ?? error} /></div>}
        {overlays}
      </div>
    )
  }

  return (
    // A title band spanning the content column (escaping <main>'s padding), then the rows at a
    // 24px inset, as on the console.
    <div className={cn('relative -mx-8 -mt-8 flex w-auto flex-col gap-4', empty && '-mb-6 min-h-[420px] flex-1')}>
      <div className="px-6">
        <div className="flex items-center py-4.5">
          <h1 className="text-[32px] leading-12 font-semibold">Service</h1>
        </div>
      </div>
      {floating}
      {empty ? (
        <div className="px-6">
          <button type="button" onClick={() => setAddFirstOpen(true)}
            className="flex w-full cursor-pointer flex-col items-center justify-center gap-3 border border-dashed border-alpha-16 bg-semantic-2 px-6 py-10 transition-colors hover:bg-card">
            <span className="text-xl leading-7 font-medium">No Service Deployed</span>
            <span className="text-sm leading-6 text-muted-foreground">Add your first service</span>
          </button>
        </div>
      ) : (
        <div className="flex flex-col px-6">
          <ServiceTable projectId={projectId} branch={branch} services={rows} health={health} isWaking={waking.isWaking}
            onOpen={openService}
            onDone={reload} onError={setActionError} onApproval={setApproval} />
        </div>
      )}
      {(actionError || error) && <div className="px-6"><ErrorNote error={actionError ?? error} /></div>}
      {overlays}
    </div>
  )
}
