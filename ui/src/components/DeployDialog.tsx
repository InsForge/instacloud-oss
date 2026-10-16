import { useMemo, useState } from 'react'
import {
  Badge, Button, cn, Input, SearchInput, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tab, Tabs,
} from '@insforge/ui'
import { api, type Service, type TemplateDetail, type TemplateListItem } from '../api'
import { usePoll } from '../hooks'
import { ALL_CATEGORIES, categoryCounts, filterTemplates, runsHere } from '../lib/catalog'
import { applyMissing, canSubmit, flattenVariables, payloadVariables } from '../lib/templateVars'
import { soleUrl, normalizeServices } from '../lib/deployment'
import type { PendingApproval } from './ApprovalPrompt'
import { DeploymentProgress, useDeployment } from './DeploymentProgress'
import { TemplateDeployForm } from './TemplateDeployForm'
import { categoryLabel, ErrorNote, Field, Modal, TemplateLogo } from './ui'

const NEW_SERVICE = '__new__'
/** The cloud's compute group rule, same shape as a service name. */
const GROUP_RE = /^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$/

type Lane = 'image' | 'template'
type Phase = 'pick' | 'form' | 'progress'

export interface DeployDialogProps {
  projectId: string
  branch: string
  /** Compute rows of the current branch: the image lane's deploy targets. */
  services: Service[]
  /** Opened from the Templates gallery: skip the picker and land on that template's form. */
  initialTemplateCode?: string
  initialLane?: Lane
  onClose: () => void
  /** Reload the caller's lists after a deploy landed. */
  onDone: () => void
  /** The compute group a deploy just started, so the row can say Waking. */
  onDeployed?: (group: string) => void
  onApproval: (p: NonNullable<PendingApproval>) => void
}

/** Deploy an image or a template into this branch (plan 07 H). Both lanes are cloud routes:
 *  `POST /projects/:id/deploy` and `POST /projects/:id/template-deployments`. */
export function DeployDialog(props: DeployDialogProps) {
  const { initialTemplateCode, initialLane, onClose } = props
  const [lane, setLane] = useState<Lane>(initialLane ?? (initialTemplateCode ? 'template' : 'image'))
  const [code, setCode] = useState<string | undefined>(initialTemplateCode)
  const [phase, setPhase] = useState<Phase>(initialTemplateCode ? 'form' : 'pick')
  const [deploymentId, setDeploymentId] = useState<string>()

  if (lane === 'template' && phase === 'progress' && deploymentId) {
    return <ProgressModal {...props} deploymentId={deploymentId} />
  }

  return (
    <Modal
      title="Deploy"
      wide={lane === 'template'}
      onClose={onClose}
      footer={null}
    >
      <Tabs value={lane} onValueChange={(v) => setLane(v as Lane)} className="mb-4">
        <Tab value="image">Image</Tab>
        <Tab value="template">Template</Tab>
      </Tabs>
      {lane === 'image' ? (
        <ImageLane {...props} />
      ) : phase === 'pick' ? (
        <TemplatePicker
          onPick={(c) => { setCode(c); setPhase('form') }}
          onCancel={onClose}
        />
      ) : (
        <TemplateLane
          {...props}
          code={code!}
          onBack={initialTemplateCode ? undefined : () => setPhase('pick')}
          onStarted={(id) => { setDeploymentId(id); setPhase('progress') }}
        />
      )}
    </Modal>
  )
}

/** `POST /projects/:id/deploy {image, port, group, branch}`: today's deploy route. */
function ImageLane({ projectId, branch, services, onClose, onDone, onDeployed, onApproval }: DeployDialogProps) {
  const groups = useMemo(() => services.filter((s) => s.type === 'compute'), [services])
  const [image, setImage] = useState('')
  const [port, setPort] = useState('8080')
  const [target, setTarget] = useState<string>(groups[0]?.name ?? NEW_SERVICE)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const group = target === NEW_SERVICE ? newName.trim() : target
  const portNum = Number(port)
  const valid = !!image.trim() && GROUP_RE.test(group) && Number.isInteger(portNum) && portNum > 0 && portNum < 65536

  const submit = async () => {
    if (!valid) return setError('An image, a port and a lower-kebab service name are required.')
    setBusy(true); setError(undefined)
    const r = await api.deployImage(projectId, { image: image.trim(), port: portNum, group, branch })
    setBusy(false)
    if (r.kind === 'error') return setError(r.error)
    if (r.kind === 'approval') { onClose(); return onApproval({ ...r, retry: submit }) }
    onDeployed?.(group)
    onClose(); onDone()
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        <Field label="Image" className="col-span-2" hint="Any registry the daemon can pull from.">
          <Input autoFocus value={image} onChange={(e) => setImage(e.target.value)} placeholder="ghcr.io/acme/web:1.2.3"
            className="font-mono" onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </Field>
        <Field label="Port" hint="The port your app listens on.">
          <Input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />
        </Field>
      </div>
      <Field label="Service">
        <Select value={target} onValueChange={setTarget}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {groups.map((s) => <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>)}
            <SelectItem value={NEW_SERVICE}>New service...</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {target === NEW_SERVICE && (
        <Field label="New service name" hint="Lower-kebab, like web or worker.">
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="web" className="font-mono"
            onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </Field>
      )}
      <p className="text-xs text-muted-foreground">
        The service starts running. When Always on is off it sleeps after the idle window and wakes on the next request.
      </p>
      <ErrorNote error={error} />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={busy || !valid}>{busy ? 'Deploying' : 'Deploy'}</Button>
      </div>
    </div>
  )
}

/** Phase 1: the bundled catalog, searched and grouped in the browser (`GET /templates`). */
function TemplatePicker({ onPick, onCancel }: { onPick: (code: string) => void; onCancel: () => void }) {
  const { data, error } = usePoll(api.templates, [], 60000)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState(ALL_CATEGORIES)
  const items = data ?? []
  const rail = useMemo(() => categoryCounts(items), [items])
  const shown = useMemo(() => filterTemplates(items, query, category), [items, query, category])

  return (
    <div className="flex flex-col gap-3">
      <SearchInput value={query} onChange={setQuery} placeholder="Search templates" debounceTime={0} />
      <div className="flex flex-wrap gap-1.5">
        {rail.map((c) => (
          <button key={c.key} type="button" onClick={() => setCategory(c.key)}
            className={cn('rounded-md px-2 py-1 text-xs font-medium capitalize transition-colors',
              category === c.key ? 'bg-alpha-8 text-foreground' : 'text-muted-foreground hover:bg-alpha-4')}>
            {c.key === ALL_CATEGORIES ? 'All' : categoryLabel(c.key)} <span className="text-muted-foreground">{c.count}</span>
          </button>
        ))}
      </div>
      <div className="max-h-[22rem] overflow-y-auto rounded-lg border border-border">
        {shown.map((t) => <PickerRow key={t.code} t={t} onPick={() => onPick(t.code)} />)}
        {data && shown.length === 0 && <p className="p-4 text-sm text-muted-foreground">No template matches that search.</p>}
        {!data && !error && <p className="p-4 text-sm text-muted-foreground">Loading the catalog...</p>}
      </div>
      <ErrorNote error={error} />
      <div className="flex justify-end">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

function PickerRow({ t, onPick }: { t: TemplateListItem; onPick: () => void }) {
  return (
    <button type="button" onClick={onPick}
      className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-alpha-4">
      <TemplateLogo src={t.logoUrl} name={t.name} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{t.name}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{t.code}</span>
        </span>
        <span className="block truncate text-xs text-muted-foreground">{t.tagline}</span>
      </span>
      {!runsHere(t) && (
        <Badge variant="default" className="font-mono" title={`This machine is ${t.hostArchitecture}`}>
          {(t.architectures ?? []).join('/')} only
        </Badge>
      )}
      <Badge variant="default" className="capitalize">{categoryLabel(t.category)}</Badge>
    </button>
  )
}

/** Phase 2: the variable form for one template, then `POST /projects/:id/template-deployments`. */
function TemplateLane({ projectId, branch, code, onBack, onClose, onApproval, onStarted }: DeployDialogProps & {
  code: string; onBack?: () => void; onStarted: (deploymentId: string) => void
}) {
  const { data: detail, error } = usePoll(() => api.template(code), [code], 60000)
  const [values, setValues] = useState<Record<string, string>>({})
  const [missing, setMissing] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()

  const vars = useMemo(() => (detail ? flattenVariables(detail) : []), [detail])
  // The daemon refuses this pair outright (its image has no manifest for this box), so the button
  // that would earn that 400 is off rather than armed.
  const ready = !!detail && runsHere(detail) && canSubmit(vars, values)

  const submit = async () => {
    if (!detail) return
    setBusy(true); setActionError(undefined); setMissing([])
    const r = await api.deployTemplate(projectId, { templateCode: detail.code, branch, variables: payloadVariables(values) })
    setBusy(false)
    if (r.kind === 'approval') {
      // Gates chain (service.add, secrets.write, deploy, service.upgrade): each grant retries.
      return onApproval({ ...r, retry: submit })
    }
    if (r.kind === 'error') {
      const names = applyMissing(r.body)
      if (names.length) { setMissing(names); return setActionError('Fill the marked variables.') }
      return setActionError(r.error)
    }
    onStarted(r.data.deploymentId ?? r.data.deployment?.id)
  }

  if (error) return <ErrorNote error={error} />
  if (!detail) return <p className="text-sm text-muted-foreground">Loading the template...</p>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <TemplateLogo src={detail.logoUrl} name={detail.name} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{detail.name}</p>
          <p className="truncate text-xs text-muted-foreground">{detail.tagline}</p>
        </div>
        <Badge variant="default" className="ml-auto font-mono">{detail.code}@{detail.version}</Badge>
      </div>
      {!runsHere(detail) && (
        <p className="rounded-md border border-border bg-alpha-4 p-3 text-xs text-muted-foreground">
          {detail.code} publishes {(detail.architectures ?? []).join(' and ')} images and this machine is{' '}
          <span className="font-mono">{detail.hostArchitecture}</span>. There is no image to pull, so this deploy
          cannot start.
        </p>
      )}
      <TemplateVarsBlock detail={detail} values={values} missing={missing}
        onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))} />
      <p className="text-xs text-muted-foreground">Deploying to branch <span className="font-mono">{branch}</span>.</p>
      <ErrorNote error={actionError} />
      <div className="flex justify-end gap-2">
        {onBack && <Button variant="secondary" onClick={onBack}>Back</Button>}
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={busy || !ready}>{busy ? 'Deploying' : `Deploy ${detail.code}`}</Button>
      </div>
    </div>
  )
}

function TemplateVarsBlock({ detail, values, missing, onChange }: {
  detail: TemplateDetail; values: Record<string, string>; missing: string[]; onChange: (n: string, v: string) => void
}) {
  return (
    <div className="max-h-[24rem] overflow-y-auto pr-1">
      <TemplateDeployForm detail={detail} values={values} missing={missing} onChange={onChange} />
    </div>
  )
}

/** Phase 3: the four-step ladder for a running deployment (`GET /template-deployments/:id`). */
function ProgressModal({ deploymentId, onClose, onDone }: DeployDialogProps & { deploymentId: string }) {
  const { dep, error, timedOut } = useDeployment(deploymentId)
  const url = soleUrl(normalizeServices(dep?.services))
  const close = () => { onDone(); onClose() }
  return (
    <Modal
      title="Deploying template"
      onClose={close}
      footer={
        <>
          {url && (
            <Button variant="secondary" onClick={() => window.open(url, '_blank', 'noreferrer')}>Open service</Button>
          )}
          <Button variant="primary" onClick={close}>Close</Button>
        </>
      }
    >
      <DeploymentProgress dep={dep} error={error} timedOut={timedOut} />
    </Modal>
  )
}
