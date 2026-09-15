// The console's service detail (insta-frontend services/service-detail-view.tsx, compute-detail.tsx,
// service-settings.tsx): a full-screen overlay over the Service page, URL-driven (`?service=<id>`,
// `&tab=`), with the side tab rail per service type and Settings as label-left rows.
//
// Tabs, as the console orders them:
//   compute   Metrics, Variables, Runtime Logs, Volume, Settings (General / Custom Domain)
//   postgres  Database, Metrics, Variables, Runtime Logs, Settings
//   managed   Metrics, Variables, Runtime Logs, Volume, Settings
//   storage   Variables, Settings
// Self-host divergences: no Deployment Logs (the daemon has no deploy-events route); Variables are
// names only (values stay behind `insta secrets`); a Runtime row for Start / Stop / Suspend, states
// the console does not have; Custom Domain only in server mode; changes apply immediately.

import { useEffect, useRef, useState } from 'react'
import {
  Button, CopyButton, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch,
} from '@insforge/ui'
import { RotateCw, X } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { api, obsComponentFor, type Service } from '../../api'
import { usePoll } from '../../hooks'
import { effectiveVariables } from '../../lib/effectiveVariables'
import { MANAGED_TYPES, tabsFor, TAB_LABELS as LABELS, type TabId } from '../../lib/serviceTabs'
import { LOWER_KEBAB_NAME_ERROR, SERVICE_NAME_RE } from '../../lib/serviceNames'
import { useAuth } from '../AuthGate'
import { ApprovalPrompt, type PendingApproval } from '../ApprovalPrompt'
import { DomainsSection } from '../DomainsSection'
import { ErrorNote, hrefFor } from '../ui'
import { LogsPanel } from '../../pages/Logs'
import { DatabasePanel } from '../../pages/DatabaseInsight'
import { MetricCharts } from '../metrics/MetricCharts'
import { VolumeSection } from '../../pages/ServiceDetail'
import { DeleteServiceDialog, RestartServiceDialog } from './ServiceDialogs'
import { SettingsCard, SettingsRow } from './SettingsRow'
import { SideTabs, TopTabs } from './Tabs'
import { ServiceTypeIcon } from './ServiceIcon'
import { hasOpenNestedDialog } from './nestedDialog'

type Ctx = {
  projectId: string; branch: string; service: Service
  onDone: () => void; onError: (m: string) => void; onApproval: (p: NonNullable<PendingApproval>) => void
}

export function ServiceDetailModal({ projectId, branch, serviceId, requestedTab, onClose }: {
  projectId: string; branch: string; serviceId: string; requestedTab: string | null; onClose: () => void
}) {
  const { mode } = useAuth()
  const { data: services, reload } = usePoll(() => api.services(projectId, branch), [projectId, branch], 5000)
  const service = services?.find((s) => s.id === serviceId)
  const [approval, setApproval] = useState<PendingApproval>(null)
  const [error, setError] = useState<string>()
  const [restartOpen, setRestartOpen] = useState(false)
  const tabs = tabsFor(service?.type ?? 'storage')
  const [tab, setTab] = useState<TabId | null>(null)
  const active: TabId = tab ?? (tabs.includes(requestedTab as TabId) ? (requestedTab as TabId) : tabs[0])
  // The URL carries `?service=&tab=` so a tab can be linked and survives a refresh, but selecting
  // one only moved local state, so reload reopened the tab the link had named rather than the one
  // in front of you. Keep the URL in step, replacing rather than stacking history entries.
  const [, setParams] = useSearchParams()
  const selectTab = (next: TabId) => {
    setTab(next)
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      p.set('tab', next)
      return p
    }, { replace: true })
  }

  const overlayRef = useRef<HTMLDivElement>(null)

  // A stale id (deleted service, another environment's link) closes instead of rendering nothing.
  const missing = services !== undefined && !service
  useEffect(() => { if (missing) onClose() }, [missing, onClose])
  // Window-level so a nested dialog's Escape wins first. `defaultPrevented` alone is not enough to
  // rely on: Radix dismisses on Escape without guaranteeing the native event is default-prevented,
  // so one Escape could close the Restart dialog AND this overlay behind it. Same guard as the
  // focus trap: while a nested dialog is open, Escape is its to handle.
  //
  // CAPTURE phase, so "is a nested dialog open?" is answered before Radix can answer it wrong.
  // This listener is on `window`, and Radix's DismissableLayer listens on `document`. The bubble
  // path runs target -> ... -> document -> window, so in bubble phase Radix ALWAYS ran first — not
  // sometimes, and not by registration order — and by the time this handler read `data-state` the
  // nested dialog it was meant to defer to already said "closed", so one Escape closed both layers.
  // The capture path is the same order reversed (window first), which is what makes the guard hold.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (hasOpenNestedDialog(overlayRef.current)) return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  // aria-modal="true" is a PROMISE to assistive tech that the rest of the page is inert, and this
  // is a plain fixed div rather than the kit's Dialog, so nothing was keeping that promise: focus
  // stayed wherever it was and Tab walked straight into the dashboard behind the overlay. Move
  // focus in, keep it in, and give it back to whatever opened this on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const root = overlayRef.current
    const focusable = () => Array.from(
      root?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
      // `tabIndex >= 0`, not just the selector: a roving tablist gives its unselected tabs
      // tabindex="-1", and they still match `button:not([disabled])`. Counting them made `last` a
      // tab the browser skips, so Tab off the selected one walked out of the overlay entirely.
    ).filter((el) => el.offsetParent !== null && el.tabIndex >= 0)

    focusable()[0]?.focus()
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !root || hasOpenNestedDialog(root)) return
      const items = focusable()
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      // Wrap at both ends, and pull focus back if it has escaped the overlay entirely.
      if (!root.contains(active)) { e.preventDefault(); first.focus(); return }
      if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
    }
    document.addEventListener('keydown', onTab)
    return () => {
      document.removeEventListener('keydown', onTab)
      opener?.focus?.()
    }
    // `service` is undefined on the first render, while the list is still loading, and the
    // component returns null then — so the overlay does not exist yet and there is nothing to
    // focus or to trap within. Re-run once it resolves, or the trap silently does nothing: a
    // browser check showed 26 of 40 Tab presses walking out into the dashboard behind it.
  }, [serviceId, service?.id])

  if (!service) return null
  // Each managed database is its own observability component; sending them all to `db` answered
  // every Redis/MySQL/Mongo tab with the environment's Postgres instead.
  const runtimeComponent = obsComponentFor(service.type)
  const accessUrl = service.type === 'compute' ? hrefFor(mode, service.domain, service.endpoint) : undefined
  const ctx: Ctx = { projectId, branch, service, onDone: reload, onError: setError, onApproval: setApproval }

  return (
    <div ref={overlayRef} className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={service.name}>
      <div className="absolute inset-0 bg-black/80" onClick={onClose} />
      <div className="absolute inset-x-6 top-16 bottom-16 mx-auto flex max-w-[1440px] flex-col overflow-hidden border border-border bg-semantic-1 shadow-[0px_8px_12px_0px_rgba(0,0,0,0.24)]">
        <div className="flex shrink-0 items-center gap-3 px-4 py-4">
          <span className="flex size-12 shrink-0 items-center justify-center bg-card">
            <ServiceTypeIcon type={service.type} className="size-8" />
          </span>
          <div className="flex min-w-0 flex-col">
            <h2 className="min-w-0 truncate text-base leading-7 font-semibold">{service.name}</h2>
            {accessUrl && (
              <div className="flex min-w-0 items-center gap-1.5 text-sm leading-5 text-muted-foreground">
                <a href={accessUrl} target="_blank" rel="noreferrer" title={accessUrl}
                  className="truncate transition-colors hover:text-foreground hover:underline">
                  {accessUrl.replace(/^https?:\/\//, '')}
                </a>
                <CopyButton text={accessUrl} showText={false} className="shrink-0" />
              </div>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {service.type === 'compute' && (
              <Button type="button" variant="destructive" className="h-9 gap-1.5" onClick={() => setRestartOpen(true)}>
                <RotateCw className="size-4" />
                Restart
              </Button>
            )}
            <button type="button" aria-label="Close" onClick={onClose}
              className="flex size-9 cursor-pointer items-center justify-center border border-border bg-card text-muted-foreground transition-colors hover:bg-alpha-4 hover:text-foreground">
              <X className="size-5" />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 pb-4">
          <div className="flex items-start gap-6">
            <SideTabs tabs={tabs.map((id) => ({ id, label: LABELS[id] }))} value={active} onChange={selectTab}
              className="sticky top-0" panelId="service-detail-panel" />
            <div id="service-detail-panel" role="tabpanel" aria-labelledby={`service-detail-panel-tab-${active}`}
              className="flex min-w-0 flex-1 flex-col gap-3">
              <ErrorNote error={error} />
              {active === 'database' && <DatabasePanel projectId={projectId} branch={branch} group={service.name} />}
              {/* The console's Metrics tab, with its time range picker for every service type. */}
              {active === 'metrics' && obsComponentFor(service.type) && (
                // Keyed by service: the overlay stays mounted when another service is opened, and a
                // fresh chart state is what keeps one service's samples from wearing the next's name.
                <MetricCharts key={service.id} projectId={projectId} component={obsComponentFor(service.type)!} branch={branch}
                  group={service.name} lineName={service.name} />
              )}
              {active === 'variables' && <VariablesTab projectId={projectId} branch={branch} service={service} />}
              {active === 'runtime' && runtimeComponent && (
                <LogsPanel projectId={projectId} branch={branch} component={runtimeComponent} service={service} />
              )}
              {active === 'volume' && <VolumeSection projectId={projectId} branch={branch} service={service} onApproval={setApproval} />}
              {active === 'settings' && <SettingsTab {...ctx} serverMode={mode === 'server'} onDeleted={onClose} />}
            </div>
          </div>
        </div>
      </div>
      {restartOpen && <RestartServiceDialog {...ctx} open={restartOpen} onOpenChange={setRestartOpen} />}
      <ApprovalPrompt projectId={projectId} pending={approval} onClose={() => setApproval(null)} />
    </div>
  )
}

/** The names this service can read, never the values (those stay behind `insta secrets`). A
 *  database or bucket lists what it mints; an app receives every service's credentials in its
 *  environment plus the project's and this environment's own secrets. */
function VariablesTab({ projectId, branch, service }: { projectId: string; branch: string; service: Service }) {
  const { data: tree, error } = usePoll(() => api.secretTree(projectId), [projectId], 15000)
  const env = tree?.branches.find((b) => b.name === branch)
  // Keyed by name in `effectiveVariables`, not appended here: the container receives ONE value
  // per name, and the same name may legitimately exist at several scopes.
  const rows = effectiveVariables(tree, env, service)
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden border border-border bg-card">
        <div className="flex items-center gap-6 border-b border-border bg-alpha-4 px-4 py-3 text-[13px] text-muted-foreground">
          <span className="min-w-0 flex-2">Name</span>
          <span className="min-w-0 flex-1">Source</span>
        </div>
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{error ? error.message : tree ? 'No variables yet.' : 'Loading…'}</p>
        ) : rows.map((r) => (
          <div key={r.name} className="flex items-center gap-6 border-b border-border px-4 py-2.5 last:border-b-0">
            <span className="min-w-0 flex-2 truncate font-mono text-[13px]">{r.name}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{r.source}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Names only. Values stay behind <span className="font-mono">insta secrets</span>.</p>
    </div>
  )
}

function SettingsTab(props: Ctx & { serverMode: boolean; onDeleted: () => void }) {
  const { projectId, branch, service, serverMode } = props
  const withDomain = service.type === 'compute' && serverMode
  const [sub, setSub] = useState<'general' | 'domain'>('general')
  return (
    <>
      {withDomain && (
        <TopTabs tabs={[{ id: 'general', label: 'General' }, { id: 'domain', label: 'Custom Domain' }] as const}
          value={sub} onChange={setSub} label="Settings views" />
      )}
      {sub === 'domain' && withDomain ? (
        <DomainsSection projectId={projectId} branch={branch} group={service.name} />
      ) : (
        <GeneralSettings {...props} />
      )}
    </>
  )
}

function GeneralSettings({ projectId, branch, service, onDone, onError, onApproval, onDeleted }: Ctx & { onDeleted: () => void }) {
  const { mode } = useAuth()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const accessUrl = service.type === 'compute' ? hrefFor(mode, service.domain, service.endpoint) : undefined
  const ctx = { projectId, branch, service, onDone, onError, onApproval }
  return (
    <>
      <SettingsCard>
        <NameRow {...ctx} />
        {service.type === 'compute' && (
          <SettingsRow label="Access URL" hint="The URL used to access this service.">
            <div className="flex min-h-8 items-center gap-2">
              {accessUrl ? (
                <>
                  <span className="truncate text-sm" title={accessUrl}>{accessUrl}</span>
                  <CopyButton text={accessUrl} showText={false} className="shrink-0" />
                </>
              ) : (
                <span className="text-sm text-muted-foreground">Deploy an image to get a URL.</span>
              )}
            </div>
          </SettingsRow>
        )}
        {service.type !== 'compute' && service.endpoint && (
          <SettingsRow label="Endpoint" hint="The host and port a client connects to.">
            <div className="flex min-h-8 items-center gap-2">
              <span className="truncate font-mono text-[13px]" title={service.endpoint}>{service.endpoint}</span>
              <CopyButton text={service.endpoint} showText={false} className="shrink-0" />
            </div>
          </SettingsRow>
        )}
        {service.image && (
          <SettingsRow label="Image" hint="The container image and tag used to deploy this service.">
            <div className="flex min-h-8 items-center gap-2">
              <span className="truncate font-mono text-[13px]" title={service.image}>{service.image}</span>
              <CopyButton text={service.image} showText={false} className="shrink-0" />
            </div>
          </SettingsRow>
        )}
        {service.type === 'compute' && service.port != null && (
          <SettingsRow label="Port" hint="The port where the service accepts incoming traffic.">
            <div className="flex min-h-8 items-center gap-2">
              <span className="font-mono text-[13px]">{service.port}</span>
              <CopyButton text={String(service.port)} showText={false} className="shrink-0" />
            </div>
          </SettingsRow>
        )}
        {(service.type === 'compute' || MANAGED_TYPES.has(service.type)) && <ScaleToZeroRow {...ctx} />}
        {service.type === 'postgres' && <DatabaseScaleToZeroRow {...ctx} />}
        {service.type === 'compute' && <RuntimeRow {...ctx} />}
        {service.type === 'storage' && <PublicAccessRow {...ctx} />}
      </SettingsCard>

      {service.type === 'compute' || MANAGED_TYPES.has(service.type)
        ? <InstanceLimitCard {...ctx} />
        : service.type === 'postgres'
          ? <PgInstanceLimitCard {...ctx} />
          : null}

      <SettingsCard>
        <div className="flex items-center gap-6">
          <div className="flex w-120 shrink-0 flex-col gap-2">
            <span className="py-1.5 text-sm text-destructive">Delete service</span>
            <p className="pb-2 text-[13px] text-destructive">
              Deleting this service permanently deletes its container, data and credentials and removes it from this
              branch. This cannot be undone.
            </p>
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>Delete Service</Button>
          </div>
        </div>
      </SettingsCard>
      {deleteOpen && (
        <DeleteServiceDialog {...ctx} onDone={() => { onDone(); onDeleted() }} open={deleteOpen} onOpenChange={setDeleteOpen} />
      )}
    </>
  )
}

function NameRow({ projectId, branch, service, onDone, onApproval }: Ctx) {
  const [text, setText] = useState(service.name)
  const [rejected, setRejected] = useState<string | null>(null)
  // Enter commits and then the field blurs, which commits again. The second request carried the
  // OLD service name and reported "service not found" even though the first rename had succeeded.
  const inFlight = useRef(false)
  const commit = async () => {
    const next = text.trim()
    if (next === service.name) return setRejected(null)
    if (!SERVICE_NAME_RE.test(next)) return setRejected(LOWER_KEBAB_NAME_ERROR)
    if (inFlight.current) return
    inFlight.current = true
    setRejected(null)
    const r = await api.renameService(projectId, service.id, next, branch).finally(() => { inFlight.current = false })
    if (r.kind === 'error') return setRejected(r.status === 409 ? `A service named ${next} already exists.` : r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void commit() } })
    onDone()
  }
  // Enter or an explicit Save, never blur. Blur fires BEFORE the click that caused it, so clicking
  // Close, or Delete Service a few rows down, used to rename the service to whatever half-typed
  // text was in the field — and the overlay could close before the result was visible. Worst for
  // storage, where a rename is a re-key and a bucket handle is baked into every object URL.
  const dirty = text.trim() !== service.name
  return (
    <SettingsRow label="Service Name" hint="A unique name for your service. Press Enter or Save to apply.">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Input value={text} aria-label="Service name" onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void commit() } }} />
          {dirty && (
            <Button variant="secondary" size="sm" onClick={() => { void commit() }}>Save</Button>
          )}
        </div>
        {rejected && <p className="text-sm text-destructive">{rejected}</p>}
      </div>
    </SettingsRow>
  )
}

/** The console's Scale to Zero: the same control as always-on, stated as the behaviour, so the
 *  switch is the inverse of `always_on`. */
function ScaleToZeroRow({ projectId, branch, service, onDone, onError, onApproval }: Ctx) {
  const [busy, setBusy] = useState(false)
  const scaleToZero = !service.always_on
  const hasVolume = service.volume_gib != null
  const set = async (next: boolean) => {
    setBusy(true)
    const r = await api.setAlwaysOn(projectId, service.id, !next, branch)
    setBusy(false)
    if (r.kind === 'error') return onError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void set(next) } })
    onDone()
  }
  return (
    <SettingsRow label="Scale to Zero"
      hint={hasVolume
        ? 'Automatically stop the service when idle. It restarts when a new request arrives, and its volume is kept.'
        : 'Automatically stop the service when idle. It restarts when a new request arrives.'}>
      <div className="flex min-h-8 items-center gap-2">
        <Switch checked={scaleToZero} disabled={busy} onCheckedChange={(v) => { void set(v) }} aria-label="Scale to zero" />
        <span className="text-sm text-muted-foreground">
          {scaleToZero ? 'Stops when idle, wakes on request' : 'Always on — never scales to zero'}
        </span>
      </div>
    </SettingsRow>
  )
}

function DatabaseScaleToZeroRow({ projectId, branch, service, onError, onApproval }: Ctx) {
  const { data, reload } = usePoll(() => api.dbInstance(projectId, branch, service.name), [projectId, branch, service.name], 15000)
  const [busy, setBusy] = useState(false)
  const set = async (next: boolean) => {
    setBusy(true)
    const r = await api.dbSettings(projectId, branch, { scaleToZero: next }, service.name)
    setBusy(false)
    if (r.kind === 'error') return onError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void set(next) } })
    reload()
  }
  const scaleToZero = data?.scaleToZero ?? true
  return (
    <SettingsRow label="Scale to Zero" hint="Automatically stop the database when idle. It wakes on the next connection.">
      <div className="flex min-h-8 items-center gap-2">
        <Switch checked={scaleToZero} disabled={busy || !data} onCheckedChange={(v) => { void set(v) }} aria-label="Scale to zero" />
        <span className="text-sm text-muted-foreground">
          {scaleToZero ? 'Stops when idle, wakes on connect' : 'Always on — never scales to zero'}
        </span>
      </div>
    </SettingsRow>
  )
}

/** Self-host only: the daemon's standing intents (a stopped service stays stopped; traffic does
 *  not wake it). */
function RuntimeRow({ projectId, branch, service, onDone, onError, onApproval }: Ctx) {
  const [busy, setBusy] = useState(false)
  const run = async (verb: 'start' | 'stop' | 'suspend') => {
    setBusy(true)
    const r = await api.lifecycle(projectId, service.id, verb, branch)
    setBusy(false)
    if (r.kind === 'error') return onError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void run(verb) } })
    onDone()
  }
  const desired = service.desired_state ?? 'running'
  return (
    <SettingsRow label="Runtime"
      hint="Stop keeps the service down until you start it again (traffic does not wake a stopped service); suspend pauses it in memory.">
      <div className="flex min-h-8 flex-wrap items-center gap-2">
        <span className="mr-2 text-sm text-muted-foreground capitalize">{desired}</span>
        {desired !== 'running' && <Button variant="secondary" size="sm" disabled={busy} onClick={() => { void run('start') }}>Start</Button>}
        {desired !== 'stopped' && <Button variant="secondary" size="sm" disabled={busy} onClick={() => { void run('stop') }}>Stop</Button>}
        {desired === 'running' && <Button variant="secondary" size="sm" disabled={busy} onClick={() => { void run('suspend') }}>Suspend</Button>}
      </div>
    </SettingsRow>
  )
}

const CPU_LADDER = [1, 2, 4, 6, 8]

/** The console's Instance Limit, as label-left rows: the service's ceiling on the provider grid
 *  (`GET|PUT …/limits`). Self-host divergence: a CPU select and a memory field instead of the
 *  console's coupled sliders, and no plan upgrade (there is no plan). */
function InstanceLimitCard({ projectId, branch, service, onApproval }: Ctx) {
  const { data, error, reload } = usePoll(() => api.limits(projectId, service.id, branch), [projectId, service.id, branch], 30000)
  const [cpu, setCpu] = useState<string>()
  const [memory, setMemory] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  if (!data) return error ? <p className="text-sm text-destructive">{error.message}</p> : null

  const cap = data.cap
  const cpuValue = cpu ?? String(data.limits.cpu)
  const memValue = memory ?? String(data.limits.memoryMb)
  const memNum = Number(memValue)
  const valid = Number.isInteger(memNum) && memNum >= 256 && memNum % 256 === 0 && memNum <= cap.memoryMb
  const dirty = Number(cpuValue) !== data.limits.cpu || memNum !== data.limits.memoryMb
  // A service can already sit on a CPU that is not on the ladder, or above the current cap (the
  // cap can move). The Select then had no matching item, so the trigger rendered BLANK while the
  // controlled value stayed at that out-of-range number and Save would happily send it. Offer the
  // current value too, so what is shown is what is set.
  const cpuOptions = [...new Set([...CPU_LADDER.filter((c) => c <= cap.cpu), data.limits.cpu])]
    .filter((c) => Number.isFinite(c))
    .sort((a, b) => a - b)

  const save = async () => {
    if (!cpuOptions.includes(Number(cpuValue))) return setSaveError('Choose one of the listed CPU sizes.')
    if (!valid) return setSaveError(`Memory is 256 MB to ${cap.memoryMb} MB, in steps of 256.`)
    setBusy(true); setSaveError(undefined)
    const r = await api.setLimits(projectId, service.id, { memoryMb: memNum, cpu: Number(cpuValue) }, branch)
    setBusy(false)
    if (r.kind === 'error') return setSaveError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void save() } })
    setCpu(undefined); setMemory(undefined)
    reload()
  }

  return (
    <SettingsCard title="Instance Limit">
      <SettingsRow label="CPU" hint="The most vCPU this service may use.">
        <Select value={cpuValue} onValueChange={setCpu}>
          <SelectTrigger className="w-40" aria-label="CPU ceiling"><SelectValue /></SelectTrigger>
          <SelectContent>
            {cpuOptions.map((c) => <SelectItem key={c} value={String(c)}>{c} vCPU</SelectItem>)}
          </SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow label="Memory" hint={`The most memory this service may use, in steps of 256 MB, up to ${cap.memoryMb} MB. Applied on the next start.`}>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Input className="w-40" inputMode="numeric" aria-label="Memory ceiling" value={memValue} onChange={(e) => setMemory(e.target.value)} />
            <span className="text-sm text-muted-foreground">MB</span>
            <Button variant="secondary" size="sm" disabled={busy || !dirty} onClick={() => { void save() }}>Save</Button>
          </div>
          {saveError && <p className="text-sm text-destructive">{saveError}</p>}
        </div>
      </SettingsRow>
    </SettingsCard>
  )
}

/** Postgres states its ceiling as quantities (`PATCH database/settings {cpu, memory}`), as the CLI
 *  and the cloud send them. */
function PgInstanceLimitCard({ projectId, branch, service, onApproval }: Ctx) {
  const { data, reload } = usePoll(() => api.dbInstance(projectId, branch, service.name), [projectId, branch, service.name], 30000)
  const [cpu, setCpu] = useState<string>()
  const [memory, setMemory] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const cpuValue = cpu ?? (data?.cpuMilli ? `${data.cpuMilli}m` : '')
  const memValue = memory ?? (data?.memoryMib ? `${data.memoryMib}Mi` : '')
  const dirty = cpu !== undefined || memory !== undefined

  const save = async () => {
    setBusy(true); setSaveError(undefined)
    const patch: { cpu?: string; memory?: string } = {}
    if (cpuValue) patch.cpu = cpuValue
    if (memValue) patch.memory = memValue
    const r = await api.dbSettings(projectId, branch, patch, service.name)
    setBusy(false)
    if (r.kind === 'error') return setSaveError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void save() } })
    setCpu(undefined); setMemory(undefined)
    reload()
  }

  return (
    <SettingsCard title="Instance Limit">
      <SettingsRow label="CPU" hint="Milli-cores, like 1000m.">
        <Input className="w-40 font-mono" aria-label="CPU" placeholder="1000m" value={cpuValue} onChange={(e) => setCpu(e.target.value)} />
      </SettingsRow>
      <SettingsRow label="Memory" hint="Mebibytes, like 1024Mi.">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Input className="w-40 font-mono" aria-label="Memory" placeholder="1024Mi" value={memValue} onChange={(e) => setMemory(e.target.value)} />
            <Button variant="secondary" size="sm" disabled={busy || !dirty} onClick={() => { void save() }}>Save</Button>
          </div>
          {saveError && <p className="text-sm text-destructive">{saveError}</p>}
        </div>
      </SettingsRow>
    </SettingsCard>
  )
}

function PublicAccessRow({ projectId, branch, service, onDone, onError, onApproval }: Ctx) {
  const [busy, setBusy] = useState(false)
  const set = async (next: boolean) => {
    setBusy(true)
    const r = await api.setAccess(projectId, service.id, next, branch)
    setBusy(false)
    if (r.kind === 'error') return onError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void set(next) } })
    onDone()
  }
  return (
    <SettingsRow label="Public Access" hint="Serve the bucket with anonymous public-read.">
      <div className="flex min-h-8 items-center">
        <Switch checked={!!service.public} disabled={busy} onCheckedChange={(v) => { void set(v) }} aria-label="Public bucket" />
      </div>
    </SettingsRow>
  )
}
