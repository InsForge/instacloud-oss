import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  Badge, Button, ConfirmDialog, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tab, Tabs,
} from '@insforge/ui'
import { ArrowLeft, RotateCw } from 'lucide-react'
import { api, relTime, type Service } from '../api'
import { usePoll, useWaking } from '../hooks'
import { deriveStatus, healthFor } from '../lib/status'
import { useAuth } from '../components/AuthGate'
import { SERVICE_NAME_RE } from '../components/AddServiceDialog'
import { ApprovalPrompt, type PendingApproval } from '../components/ApprovalPrompt'
import { DomainsSection } from '../components/DomainsSection'
import { ErrorNote, Field, HostLink, Section, StatusCell, TemplateLogo, TypeIcon } from '../components/ui'
import { AlwaysOnSwitch, PgAlwaysOnSwitch } from './Services'

const MANAGED = new Set(['redis', 'mysql', 'mongodb'])
const CPU_CHOICES = [1, 2, 4, 6, 8]
const SLEEP_HINT = 'Never put to sleep when idle. Off: sleeps after the idle window and wakes on the next request or connection.'

type PaneKey = 'overview' | 'settings'

/** One service (plan 07 F): Overview and Settings, both built from the branch-scoped row plus the
 *  cloud's per-service routes. The row id comes from the same `?branch=` listing (decision 49), so
 *  a branch switch sends the visitor back to the list. */
export function ServiceDetail() {
  const { projectId, branch, sid } = useParams() as { projectId: string; branch: string; sid: string }
  const { mode } = useAuth()
  const nav = useNavigate()
  const waking = useWaking()
  const interval = waking.anyWaking ? 2000 : 5000
  const { data: services, error, reload } = usePoll(() => api.services(projectId, branch), [projectId, branch], interval)
  const { data: health } = usePoll(() => api.runtimeHealth(projectId, branch), [projectId, branch], interval)
  const [pane, setPane] = useState<PaneKey>('overview')
  const [approval, setApproval] = useState<PendingApproval>(null)
  const [actionError, setActionError] = useState<string>()

  const service = useMemo(() => (services ?? []).find((s) => s.id === sid), [services, sid])
  const listUrl = `/p/${projectId}/${branch}/services`

  useEffect(() => { waking.reconcile(health, healthFor) }, [health, waking])
  // The id is branch-scoped: after a branch switch it does not exist, so fall back to the list.
  useEffect(() => {
    if (services && !service) nav(listUrl, { replace: true })
  }, [services, service, nav, listUrl])

  if (error) return <ErrorNote error={error} />
  if (!service) return null

  const h = healthFor(health, service.id)
  const status = deriveStatus(service, h, waking.isWaking(service.id))

  const wake = async () => {
    setActionError(undefined)
    const r = await api.lifecycle(projectId, service.id, 'start', branch)
    if (r.kind === 'error') return setActionError(r.error)
    if (r.kind === 'approval') return setApproval({ ...r, retry: wake })
    waking.wake(service.id)
    reload()
  }

  const restart = async () => {
    setActionError(undefined)
    const r = await api.lifecycle(projectId, service.id, 'restart', branch)
    if (r.kind === 'error') return setActionError(r.error)
    if (r.kind === 'approval') return setApproval({ ...r, retry: restart })
    waking.wake(service.id)
    reload()
  }

  return (
    <div className="mx-auto flex w-full max-w-[64rem] flex-col gap-5">
      <Link to={listUrl} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Services
      </Link>

      <div className="flex items-start gap-3">
        {service.template_code
          ? <TemplateLogo src={null} name={service.template_code} className="size-10" />
          : <TypeIcon type={service.type} className="size-10" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-2xl font-bold">{service.name}</h1>
            <Badge variant="default" className="capitalize">{service.type}</Badge>
            {service.template_code && <Badge variant="default" className="font-mono">{service.template_code}</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <StatusCell row={service} health={h} waking={waking.isWaking(service.id)} onWake={wake} />
            <HostLink domain={service.domain} endpoint={service.endpoint} mode={mode} link={service.type === 'compute'}
              sleeping={status.kind === 'sleeping'} />
          </div>
        </div>
        {service.type === 'compute' && (
          <Button variant="secondary" className="gap-1.5" onClick={restart}>
            <RotateCw className="size-4" /> Restart
          </Button>
        )}
      </div>

      <Tabs value={pane} onValueChange={(v) => setPane(v as PaneKey)}>
        <Tab value="overview">Overview</Tab>
        <Tab value="settings">Settings</Tab>
      </Tabs>

      <ErrorNote error={actionError} />

      {pane === 'overview' ? (
        <Overview service={service} />
      ) : (
        <div className="flex flex-col gap-4">
          <GeneralSection projectId={projectId} branch={branch} service={service} onDone={reload}
            onApproval={setApproval} />
          <SleepSection projectId={projectId} branch={branch} service={service} status={status.kind} onDone={reload}
            onError={setActionError} onApproval={setApproval} />
          <ResourcesSection projectId={projectId} branch={branch} service={service} onApproval={setApproval} />
          <VolumeSection projectId={projectId} branch={branch} service={service} onApproval={setApproval} />
          {service.type === 'compute' && mode === 'server' && (
            <DomainsSection projectId={projectId} branch={branch} group={service.name} />
          )}
          <DangerSection projectId={projectId} branch={branch} service={service}
            onRemoved={() => nav(listUrl, { replace: true })} onApproval={setApproval} />
        </div>
      )}

      <ApprovalPrompt projectId={projectId} pending={approval} onClose={() => setApproval(null)} />
    </div>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-xs text-foreground" title={value}>{value}</span>
    </div>
  )
}

function Overview({ service: s }: { service: Service }) {
  return (
    <Section title="Overview" description="What this service is running right now.">
      <div className="flex flex-col">
        <Line label="Image" value={s.image ?? '—'} />
        <Line label="Port" value={s.port ? String(s.port) : '—'} />
        <Line label="Volume" value={s.volume_gib ? `${s.volume_gib} Gi` : 'none'} />
        <Line label="Desired state" value={s.desired_state ?? 'running'} />
        <Line label="Template" value={s.template_code ?? '—'} />
        <Line label="Last update" value={relTime(s.updated_at)} />
      </div>
    </Section>
  )
}

function GeneralSection({ projectId, branch, service, onDone, onApproval }: {
  projectId: string; branch: string; service: Service; onDone: () => void
  onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const [name, setName] = useState(service.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const n = name.trim()
  const valid = SERVICE_NAME_RE.test(n)

  const save = async () => {
    if (!valid) return setError('Lower-case letters, digits and hyphens; max 39 characters.')
    setBusy(true); setError(undefined)
    const r = await api.renameService(projectId, service.id, n, branch)
    setBusy(false)
    if (r.kind === 'error') return setError(r.status === 409 ? `A service named ${n} already exists.` : r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: save })
    onDone()
  }

  return (
    <Section title="General" description="The name the CLI, secrets and hostnames use.">
      <div className="flex items-end gap-2">
        <Field label="Name" className="flex-1">
          <Input value={name} onChange={(e) => setName(e.target.value)} className="font-mono"
            onKeyDown={(e) => e.key === 'Enter' && save()} />
        </Field>
        <Button variant="secondary" onClick={save} disabled={busy || !valid || n === service.name}>Rename</Button>
      </div>
      <ErrorNote error={error} />
    </Section>
  )
}

function SleepSection({ projectId, branch, service, status, onDone, onError, onApproval }: {
  projectId: string; branch: string; service: Service; status: string; onDone: () => void
  onError: (m: string) => void; onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const supported = service.type === 'compute' || MANAGED.has(service.type) || service.type === 'postgres'
  if (!supported) {
    return (
      <Section title="Sleep" description="Object storage is always available; there is nothing to put to sleep.">
        <p className="text-xs text-muted-foreground">Buckets do not sleep.</p>
      </Section>
    )
  }
  return (
    <Section title="Sleep" description="Idle services stop and wake on demand, so a small box can host many of them.">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Always on</p>
          <p className="text-xs text-muted-foreground">{SLEEP_HINT}</p>
          {service.type === 'compute' && status === 'stopped' && (
            <p className="mt-1 text-xs text-warning">Start it to re-enable wake on request.</p>
          )}
        </div>
        {service.type === 'postgres' ? (
          <PgAlwaysOnSwitch projectId={projectId} branch={branch} group={service.name}
            onError={onError} onApproval={onApproval} />
        ) : (
          <AlwaysOnSwitch projectId={projectId} branch={branch} service={service} onDone={onDone}
            onError={onError} onApproval={onApproval} />
        )}
      </div>
    </Section>
  )
}

/** Compute and managed rows use `GET|PUT /services/:sid/limits`; postgres uses the database
 *  settings patch with Kubernetes-style quantities, as on the cloud. */
function ResourcesSection({ projectId, branch, service, onApproval }: {
  projectId: string; branch: string; service: Service
  onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const isPg = service.type === 'postgres'
  const supported = service.type === 'compute' || MANAGED.has(service.type) || isPg
  if (!supported) return null
  return isPg
    ? <PgResources projectId={projectId} branch={branch} group={service.name} onApproval={onApproval} />
    : <ComputeResources projectId={projectId} branch={branch} service={service} onApproval={onApproval} />
}

export function ComputeResources({ projectId, branch, service, onApproval }: {
  projectId: string; branch: string; service: Service
  onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const { data, error, reload } = usePoll(() => api.limits(projectId, service.id, branch), [projectId, service.id, branch], 30000)
  const [cpu, setCpu] = useState<string>()
  const [memory, setMemory] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()

  const cpuValue = cpu ?? (data ? String(data.limits.cpu) : '')
  const memValue = memory ?? (data ? String(data.limits.memoryMb) : '')
  const cap = data?.cap
  const memNum = Number(memValue)
  const valid = !!data && Number.isInteger(memNum) && memNum >= 256 && (!cap || memNum <= cap.memoryMb)
  const dirty = !!data && (Number(cpuValue) !== data.limits.cpu || memNum !== data.limits.memoryMb)

  const save = async () => {
    if (!valid) return setActionError(`Memory is 256 MB to ${cap?.memoryMb ?? 256} MB, in steps of 256.`)
    setBusy(true); setActionError(undefined)
    const r = await api.setLimits(projectId, service.id, { memoryMb: memNum, cpu: Number(cpuValue) }, branch)
    setBusy(false)
    if (r.kind === 'error') return setActionError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: save })
    setCpu(undefined); setMemory(undefined)
    reload()
  }

  const choices = CPU_CHOICES.filter((c) => !cap || c <= cap.cpu)
  return (
    <Section title="Resources" description="The ceiling for this container; it is applied on the next start.">
      <div className="grid grid-cols-2 gap-3">
        <Field label="vCPU">
          <Select value={cpuValue} onValueChange={setCpu}>
            <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
            <SelectContent>
              {choices.map((c) => <SelectItem key={c} value={String(c)}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Memory (MB)">
          <Input type="number" min={256} step={256} max={cap?.memoryMb} value={memValue}
            onChange={(e) => setMemory(e.target.value)} />
        </Field>
      </div>
      {cap && <p className="mt-2 text-xs text-muted-foreground">Ceiling: {cap.cpu} vCPU, {cap.memoryMb} MB. It is the grid the API accepts, not this box: a limit above what the box has is a limit the container never reaches.</p>}
      <ErrorNote error={actionError ?? error} />
      <div className="mt-3 flex justify-end">
        <Button variant="secondary" onClick={save} disabled={busy || !valid || !dirty}>Save</Button>
      </div>
    </Section>
  )
}

export function PgResources({ projectId, branch, group, onApproval }: {
  projectId: string; branch: string; group: string
  onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const { data, error, reload } = usePoll(() => api.dbInstance(projectId, branch, group), [projectId, branch, group], 30000)
  const [cpu, setCpu] = useState<string>()
  const [memory, setMemory] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()

  const cpuValue = cpu ?? (data?.cpuMilli ? `${data.cpuMilli}m` : '')
  const memValue = memory ?? (data?.memoryMib ? `${data.memoryMib}Mi` : '')

  const save = async () => {
    setBusy(true); setActionError(undefined)
    const patch: { cpu?: string; memory?: string } = {}
    if (cpuValue) patch.cpu = cpuValue
    if (memValue) patch.memory = memValue
    const r = await api.dbSettings(projectId, branch, patch, group)
    setBusy(false)
    if (r.kind === 'error') return setActionError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: save })
    setCpu(undefined); setMemory(undefined)
    reload()
  }

  return (
    <Section title="Resources" description="Quantities, as the CLI and the cloud send them.">
      <div className="grid grid-cols-2 gap-3">
        <Field label="CPU" hint="Milli-cores, like 1000m.">
          <Input value={cpuValue} onChange={(e) => setCpu(e.target.value)} placeholder="1000m" className="font-mono" />
        </Field>
        <Field label="Memory" hint="Mebibytes, like 1024Mi.">
          <Input value={memValue} onChange={(e) => setMemory(e.target.value)} placeholder="1024Mi" className="font-mono" />
        </Field>
      </div>
      <ErrorNote error={actionError ?? error} />
      <div className="mt-3 flex justify-end">
        <Button variant="secondary" onClick={save} disabled={busy}>Save</Button>
      </div>
    </Section>
  )
}

export function VolumeSection({ projectId, branch, service, onApproval }: {
  projectId: string; branch: string; service: Service
  onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const supported = service.type === 'compute' || MANAGED.has(service.type)
  const { data, error, reload } = usePoll(
    () => api.volume(projectId, service.id, branch),
    [projectId, service.id, branch],
    { intervalMs: 30000, enabled: supported },
  )
  const [size, setSize] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()
  if (!supported) return null

  const current = data?.volume?.sizeGib
  const value = size ?? (current ? String(current) : '1')
  const num = Number(value)
  const cap = data?.cap?.volumeGib
  const valid = Number.isInteger(num) && num >= 1 && (!cap || num <= cap) && (!current || num >= current)

  const save = async () => {
    if (!valid) return setActionError(current
      ? `A volume only grows: ${current} Gi or more, up to ${cap ?? current} Gi.`
      : `Pick a whole number of gibibytes, up to ${cap ?? 1} Gi.`)
    setBusy(true); setActionError(undefined)
    const r = await api.setVolume(projectId, service.id, num, branch)
    setBusy(false)
    if (r.kind === 'error') return setActionError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: save })
    setSize(undefined)
    reload()
  }

  return (
    <Section title="Volume"
      description={current ? 'A volume grows in place; it never shrinks.' : 'Attach a disk that survives redeploys.'}>
      <div className="flex items-end gap-2">
        <Field label="Size (Gi)" className="w-32">
          <Input type="number" min={current ?? 1} max={cap} value={value} onChange={(e) => setSize(e.target.value)} />
        </Field>
        <Button variant="secondary" onClick={save} disabled={busy || !valid}>{current ? 'Grow' : 'Attach'}</Button>
      </div>
      {data?.volume?.mountPath && (
        <p className="mt-2 text-xs text-muted-foreground">Mounted at <span className="font-mono">{data.volume.mountPath}</span>.</p>
      )}
      {cap && <p className="mt-1 text-xs text-muted-foreground">Ceiling: {cap} Gi. Free space on the data volume is the real limit.</p>}
      <ErrorNote error={actionError ?? error} />
    </Section>
  )
}

function DangerSection({ projectId, branch, service, onRemoved, onApproval }: {
  projectId: string; branch: string; service: Service; onRemoved: () => void
  onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const remove = async () => {
    setBusy(true); setError(undefined)
    const r = await api.removeService(projectId, service.id, branch)
    setBusy(false); setOpen(false)
    if (r.kind === 'error') return setError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: remove })
    onRemoved()
  }

  return (
    <Section title="Danger zone" description="Removing a service destroys its container, volume and credentials." danger>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">This cannot be undone.</p>
        <Button variant="destructive" onClick={() => setOpen(true)}>Remove service</Button>
      </div>
      <ErrorNote error={error} />
      <ConfirmDialog open={open} onOpenChange={setOpen} title="Remove service"
        description={`${service.name} and its data are destroyed. This cannot be undone.`}
        confirmText="Remove" destructive isLoading={busy} onConfirm={remove} />
    </Section>
  )
}
