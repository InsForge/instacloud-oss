// The console's add-service flow (insta-frontend services/add-service-button.tsx,
// add-first-service-dialog.tsx, create-service-dialog.tsx, deploy-image-dialog.tsx,
// service-sources.tsx, use-add-service-flow.tsx): one list of sources behind both pickers, the
// header dropdown and the empty state's grid, each opening its dialog in place.
//
// Self-host divergences, each because the daemon cannot do the console's version:
//   - no "Github Repo" source (the daemon has no GitHub deploy; source deploys go through the CLI)
//   - no Region row (one node, one region)
//   - the image dialog asks for the Port (there is no registry inspect to detect it)
//   - Always On shows what the daemon will do on THIS environment (always-on on the default
//     branch while the daemon's default is on, scale-to-zero on a preview) and is sent only when
//     changed; the console always starts it on and always sends it
//   - creates apply now instead of staging into an apply-changes batch

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  Button, cn, Dialog, DialogBody, DialogClose, DialogContent, DialogDivider, DialogFooter, DialogHeader, DialogTitle,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
  DropdownMenuTrigger, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch,
} from '@insforge/ui'
import { Database, Globe, LayoutTemplate, Plus } from 'lucide-react'
import { api, type BranchInfo, type Service, type ServiceType } from '../../api'
import { useAuth } from '../AuthGate'
import type { PendingApproval } from '../ApprovalPrompt'
import { alwaysOnChoice, canSubmitCompute, type AlwaysOnChoice } from '../../lib/alwaysOn'
import {
  LOWER_KEBAB_NAME_ERROR, SERVICE_NAME_RE, suggestServiceName, uniqueServiceName, whimsicalBaseName,
} from '../../lib/serviceNames'
import { AdvancedSettings, DEFAULT_VOLUME_GIB, FormRow, VolumeFormRow } from './FormRows'
import { ServiceIcon, ServiceTypeIcon } from './ServiceIcon'
import { DeployDialog } from '../DeployDialog'
import { TemplateDeployDialog } from './TemplateDeployDialog'

type CreateFlow = { kind: 'create'; type: ServiceType; label: string; placeholder: string }
type Flow = CreateFlow | { kind: 'image' } | { kind: 'templates' } | { kind: 'template-deploy'; code: string }

export const SECTIONS = [
  { category: 'code', label: 'Deploy your code', cols: 'grid-cols-2' },
  { category: 'database', label: 'Databases', cols: 'grid-cols-2' },
  { category: 'storage', label: 'Storage', cols: 'grid-cols-2' },
  { category: 'bundle', label: 'Templates', cols: 'grid-cols-1' },
] as const
type Category = (typeof SECTIONS)[number]['category']

type Source = { key: string; label: string; category: Category; flow: Flow; icon: (className: string) => ReactNode }

const SOURCES: Source[] = [
  { key: 'docker', label: 'Docker Image', category: 'code', flow: { kind: 'image' }, icon: (c) => <ServiceIcon service="docker" className={c} /> },
  { key: 'compute', label: 'Empty Service', category: 'code', flow: { kind: 'create', type: 'compute', label: 'Empty Service', placeholder: 'compute' }, icon: (c) => <ServiceTypeIcon type="compute" className={c} /> },
  { key: 'postgres', label: 'Postgres', category: 'database', flow: { kind: 'create', type: 'postgres', label: 'Postgres', placeholder: 'main-db' }, icon: (c) => <ServiceIcon service="postgresql" className={c} /> },
  { key: 'redis', label: 'Redis', category: 'database', flow: { kind: 'create', type: 'redis', label: 'Redis', placeholder: 'cache' }, icon: (c) => <ServiceIcon service="redis" className={c} /> },
  { key: 'mysql', label: 'MySQL', category: 'database', flow: { kind: 'create', type: 'mysql', label: 'MySQL', placeholder: 'mysql-db' }, icon: (c) => <ServiceIcon service="mysql" className={c} /> },
  { key: 'mongodb', label: 'MongoDB', category: 'database', flow: { kind: 'create', type: 'mongodb', label: 'MongoDB', placeholder: 'mongo-db' }, icon: (c) => <ServiceIcon service="mongodb" className={c} /> },
  { key: 'storage', label: 'Object Storage', category: 'storage', flow: { kind: 'create', type: 'storage', label: 'Object Storage', placeholder: 'assets' }, icon: (c) => <ServiceTypeIcon type="storage" className={c} /> },
  { key: 'template', label: 'View Templates', category: 'bundle', flow: { kind: 'templates' }, icon: (c) => <LayoutTemplate className={cn(c, 'text-muted-foreground')} /> },
]

const sourcesIn = (category: Category) => SOURCES.filter((s) => s.category === category)

type FlowProps = {
  projectId: string; branch: string; services: Service[]
  onDone: () => void; onApproval: (p: NonNullable<PendingApproval>) => void
}

/** `pick` opens a source's dialog in place; render `dialogs`. View Templates is the console's Deploy a Template
 *  dialog, and a picked template continues into the template deploy form. */
function useAddServiceFlow(props: FlowProps, onClosed?: () => void): { pick: (source: Source) => void; dialogs: ReactNode } {
  const [flow, setFlow] = useState<Flow | null>(null)
  const close = (open: boolean) => { if (!open) { setFlow(null); onClosed?.() } }
  const pick = (source: Source) => setFlow(source.flow)
  const dialogs = (
    <>
      {flow?.kind === 'create' && (
        <CreateServiceDialog {...props} flow={flow} open onOpenChange={close}
          onConnectImage={flow.type === 'compute' ? () => setFlow({ kind: 'image' }) : undefined} />
      )}
      {flow?.kind === 'image' && <DeployImageDialog {...props} open onOpenChange={close} />}
      {flow?.kind === 'templates' && (
        <TemplateDeployDialog open projectId={props.projectId} branch={props.branch} onOpenChange={close}
          onPicked={(code) => setFlow({ kind: 'template-deploy', code })} />
      )}
      {flow?.kind === 'template-deploy' && (
        <DeployDialog projectId={props.projectId} branch={props.branch} services={props.services} initialLane="template"
          initialTemplateCode={flow.code} onClose={() => close(false)} onDone={props.onDone} onApproval={props.onApproval} />
      )}
    </>
  )
  return { pick, dialogs }
}

export function AddServiceButton(props: FlowProps & { variant?: 'primary' | 'secondary' }) {
  const { variant = 'primary', ...flowProps } = props
  const { pick, dialogs } = useAddServiceFlow(flowProps)
  const item = (source: Source) => (
    <DropdownMenuItem key={source.key} onSelect={() => pick(source)}>
      {source.icon('size-4 shrink-0')}
      {source.label}
    </DropdownMenuItem>
  )
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant={variant} size={variant === 'secondary' ? 'sm' : undefined} className="h-9 gap-1.5">
            <Plus className="size-4" />
            Add Service
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          {sourcesIn('code').map(item)}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Database className="size-4 shrink-0 text-muted-foreground" />
              Databases
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">{sourcesIn('database').map(item)}</DropdownMenuSubContent>
          </DropdownMenuSub>
          {sourcesIn('storage').map(item)}
          {sourcesIn('bundle').map(item)}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialogs}
    </>
  )
}

/** The empty state's picker: a grouped grid of every source. */
export function AddFirstServiceDialog(props: FlowProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { open, onOpenChange, ...flowProps } = props
  const { pick, dialogs } = useAddServiceFlow(flowProps)
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-[544px]">
          <DialogHeader className="border-b-0 py-4">
            <DialogTitle className="w-full text-center">Add Your Service</DialogTitle>
          </DialogHeader>
          <DialogBody className="max-h-[70vh] gap-4 overflow-y-auto pt-0">
            {SECTIONS.map((section) => (
              <div key={section.category} className="flex flex-col gap-2">
                <h3 className="text-xs font-bold tracking-wider text-muted-foreground uppercase">{section.label}</h3>
                <div className={cn('grid gap-2', section.cols)}>
                  {sourcesIn(section.category).map((source) => (
                    <button key={source.key} type="button" onClick={() => { onOpenChange(false); pick(source) }}
                      className="flex cursor-pointer items-center gap-1 border border-border bg-alpha-4 p-4 text-sm transition-colors hover:bg-alpha-8">
                      {source.icon('size-5 shrink-0')}
                      <span className="truncate px-1">{source.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </DialogBody>
        </DialogContent>
      </Dialog>
      {dialogs}
    </>
  )
}

/** One source's dialog, opened straight away: a deep link's target (Quick Start's `?add=postgres`).
 *  `onClose` fires when that dialog closes, so the caller can unmount it. */
export function AddSourceDialog(props: FlowProps & { sourceKey: string; onClose: () => void }) {
  const { sourceKey, onClose, ...flowProps } = props
  const { pick, dialogs } = useAddServiceFlow(flowProps, onClose)
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    const source = SOURCES.find((s) => s.key === sourceKey)
    if (source) pick(source)
    else onClose()
  }, [sourceKey, pick, onClose])
  return <>{dialogs}</>
}

/** Whether the dialog's environment is the default branch, read once (it does not change while
 *  the dialog is open). A branch missing from the list is unknown, not a preview branch. */
function useIsDefaultBranch(projectId: string, branch: string): { isDefaultBranch: boolean | undefined; unreadable: boolean } {
  const [branches, setBranches] = useState<BranchInfo[]>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setBranches(undefined)
    setFailed(false)
    let alive = true
    api.branches(projectId).then((b) => { if (alive) setBranches(b) }, () => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [projectId])
  const current = branches?.find((b) => b.name === branch)
  return { isDefaultBranch: current ? current.is_default === true : undefined, unreadable: failed || (branches !== undefined && !current) }
}

function AlwaysOnRow({ choice, defaultOn, unreadable, onPick }: {
  choice: AlwaysOnChoice; defaultOn: boolean; unreadable: boolean; onPick: (v: boolean) => void
}) {
  const hint = !choice.known
    ? unreadable ? "Couldn't read this branch: choose on or off." : 'Checking this branch…'
    : defaultOn
      ? 'Keep it running instead of stopping it when idle. On by default here; turn off to scale to zero.'
      : 'Keep it running instead of stopping it when idle. Off by default on this branch; turn on to keep it running.'
  return (
    <FormRow label="Always On" hint={hint}>
      <Switch checked={choice.value} onCheckedChange={onPick} aria-label="Always on" />
    </FormRow>
  )
}

function parseVolumeGib(raw: string): number | null {
  const n = Number(raw.trim())
  return Number.isInteger(n) && n >= 1 ? n : null
}

function CreateServiceDialog({ projectId, branch, services, flow, onConnectImage, open, onOpenChange, onDone, onApproval }: FlowProps & {
  flow: CreateFlow; onConnectImage?: () => void; open: boolean; onOpenChange: (open: boolean) => void
}) {
  const { boot } = useAuth()
  const { type, label, placeholder } = flow
  const taken = new Set(services.filter((s) => s.type === type).map((s) => s.name))
  const [whimsy] = useState(() => whimsicalBaseName())
  const defaultName = uniqueServiceName(type === 'compute' ? whimsy : type, taken)
  const [nameInput, setNameInput] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const name = nameEdited ? nameInput : defaultName
  const [isPublic, setIsPublic] = useState(false)
  const [picked, setPicked] = useState<boolean | null>(null)
  const [volumeEnabled, setVolumeEnabled] = useState(false)
  const [volumeGib, setVolumeGib] = useState(String(DEFAULT_VOLUME_GIB))
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { isDefaultBranch, unreadable } = useIsDefaultBranch(projectId, branch)
  const choice = alwaysOnChoice({ picked, bootDefault: boot.alwaysOnDefault, isDefaultBranch })

  const create = async (body: Parameters<typeof api.addService>[1]) => {
    setBusy(true)
    const r = await api.addService(projectId, body)
    setBusy(false)
    if (r.kind === 'error') return setError(r.status === 409 ? `A ${label} named ${body.name} already exists.` : r.error)
    // Close on success only, like the environment, rename and image flows. Closing first sent a
    // failed approval-retry's error to an unmounted dialog, and abandoning the approval threw away
    // the configuration that had been typed.
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void create(body) } })
    onOpenChange(false)
    onDone()
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    const next = name.trim()
    if (!SERVICE_NAME_RE.test(next)) return setError(LOWER_KEBAB_NAME_ERROR)
    const compute = type === 'compute'
    const nextVolumeGib = compute && volumeEnabled ? parseVolumeGib(volumeGib) : null
    if (compute && volumeEnabled && nextVolumeGib === null) { setAdvancedOpen(true); return setError('Volume size must be a whole number of GB, at least 1.') }
    // The Enter key reaches here too: an untouched create waits until the switch can say what it
    // will do.
    if (compute && !canSubmitCompute(choice)) { setAdvancedOpen(true); return setError('Choose Always On or off first.') }
    void create({
      type, name: next, branch,
      ...(type === 'storage' ? { public: isPublic } : {}),
      ...(compute && choice.send !== undefined ? { alwaysOn: choice.send } : {}),
      ...(nextVolumeGib !== null ? { volumeGib: nextVolumeGib } : {}),
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ServiceTypeIcon type={type} className="size-5" />
            {label}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-col">
          <DialogBody className="min-h-0 overflow-y-auto">
            {onConnectImage && (
              <>
                <FormRow label={<>Connect <span className="text-muted-foreground">(Optional)</span></>}
                  hint="Connect your service to a Docker image.">
                  <Button type="button" variant="secondary" size="sm" onClick={onConnectImage}>
                    <ServiceIcon service="docker" className="size-4" />
                    Connect Image
                  </Button>
                </FormRow>
                <DialogDivider />
              </>
            )}
            <FormRow htmlFor="svc-name" label="Service Name" hint="A unique name for your service.">
              <Input id="svc-name" name="name" required autoFocus placeholder={placeholder} value={name}
                onChange={(e) => { setNameInput(e.target.value); setNameEdited(true) }} />
            </FormRow>
            {type === 'storage' && (
              <>
                <DialogDivider />
                <FormRow label="Public" hint="Serve the bucket with anonymous public-read.">
                  <Switch checked={isPublic} onCheckedChange={setIsPublic} aria-label="Public bucket" />
                </FormRow>
              </>
            )}
            {type === 'compute' && (
              <AdvancedSettings open={advancedOpen} onOpenChange={setAdvancedOpen}>
                <AlwaysOnRow choice={choice} defaultOn={boot.alwaysOnDefault && isDefaultBranch === true} unreadable={unreadable} onPick={setPicked} />
                <VolumeFormRow enabled={volumeEnabled} onEnabledChange={setVolumeEnabled} sizeGib={volumeGib} onSizeChange={setVolumeGib} />
              </AdvancedSettings>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={!name.trim() || busy || (type === 'compute' && !choice.known)}>
              {busy ? 'Adding…' : 'Add'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Docker Image (the console's two steps: the image, then the service it becomes). */
function DeployImageDialog({ projectId, branch, services, open, onOpenChange, onDone, onApproval }: FlowProps & {
  open: boolean; onOpenChange: (open: boolean) => void
}) {
  const { boot } = useAuth()
  const [step, setStep] = useState<'source' | 'configure'>('source')
  const [image, setImage] = useState('')
  const [nameInput, setNameInput] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [port, setPort] = useState('8080')
  const [picked, setPicked] = useState<boolean | null>(null)
  const [volumeEnabled, setVolumeEnabled] = useState(false)
  const [volumeGib, setVolumeGib] = useState(String(DEFAULT_VOLUME_GIB))
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { isDefaultBranch, unreadable } = useIsDefaultBranch(projectId, branch)
  const choice = alwaysOnChoice({ picked, bootDefault: boot.alwaysOnDefault, isDefaultBranch })

  const ref = image.trim()
  const taken = new Set(services.filter((s) => s.type === 'compute').map((s) => s.name))
  // Registration and deploy are two operations, and the second can fail or be held for approval
  // after the first has already succeeded. Remember a completed registration so submitting again
  // resumes at the deploy: without this, the retry called addService on a name its own first
  // attempt had just created, hit the 409, and the only way forward was to delete the service.
  const registered = useRef<string | null>(null)
  // Once a registration exists the name is FROZEN to it. The unedited name is derived from the
  // image, so a retry where the user went back and changed the image (one suggesting `app` to one
  // suggesting `worker`) silently moved the target: `run` registered `worker` and left the empty
  // `app` it had already created behind, with nothing in the UI pointing at it.
  const derived = nameEdited ? nameInput : uniqueServiceName(suggestServiceName(ref) || 'app', taken)
  const name = registered.current ?? derived

  // Register the service with the choices made here, then put the image on it. Each step can be
  // held for approval; a grant resumes from the step that was held.
  const deploy = async (group: string, portNum: number) => {
    const d = await api.deployImage(projectId, { image: ref, port: portNum, group, branch })
    setBusy(false)
    if (d.kind === 'error') {
      return setError(`${d.error} The service ${group} was created; submitting again retries the deploy.`)
    }
    // Close on success only. Closing before the approval hand-off meant a retry that failed after
    // the grant called setError on an unmounted dialog, and the failure was invisible.
    if (d.kind === 'approval') return onApproval({ ...d, retry: () => { void deploy(group, portNum) } })
    onOpenChange(false)
    onDone()
  }
  const run = async (body: Parameters<typeof api.addService>[1], portNum: number) => {
    setBusy(true)
    if (registered.current !== body.name) {
      const a = await api.addService(projectId, body)
      if (a.kind === 'error') { setBusy(false); return setError(a.status === 409 ? `A service named ${body.name} already exists.` : a.error) }
      if (a.kind === 'approval') { setBusy(false); return onApproval({ ...a, retry: () => { void run(body, portNum) } }) }
      registered.current = body.name
    }
    await deploy(body.name, portNum)
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    if (step === 'source') { if (ref) setStep('configure'); return }
    const next = name.trim()
    if (!SERVICE_NAME_RE.test(next)) return setError(LOWER_KEBAB_NAME_ERROR)
    const portNum = Number(port)
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return setError('Port must be a whole number between 1 and 65535.')
    const nextVolumeGib = volumeEnabled ? parseVolumeGib(volumeGib) : null
    if (volumeEnabled && nextVolumeGib === null) { setAdvancedOpen(true); return setError('Volume size must be a whole number of GB, at least 1.') }
    if (!canSubmitCompute(choice)) { setAdvancedOpen(true); return setError('Choose Always On or off first.') }
    void run({
      type: 'compute', name: next, branch, port: portNum,
      ...(choice.send !== undefined ? { alwaysOn: choice.send } : {}),
      ...(nextVolumeGib !== null ? { volumeGib: nextVolumeGib } : {}),
    }, portNum)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ServiceIcon service="docker" className="size-5" />
            Docker Image
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-col">
          {step === 'source' ? (
            <DialogBody className="min-h-0 overflow-y-auto">
              <FormRow htmlFor="svc-image" label="Image URL" hint="Deploy an image from a public Docker registry.">
                <div className="relative">
                  <Globe className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input id="svc-image" name="image" required autoFocus className="pr-8 pl-8" placeholder="docker.io/insforge/insforge-oss:v2.0.9"
                    value={image} onChange={(e) => setImage(e.target.value)} />
                </div>
              </FormRow>
              <DialogDivider />
              <FormRow label="Credential (Optional)">
                <div title="Private-registry credentials aren't supported yet">
                  <Select value="none" disabled>
                    <SelectTrigger aria-label="Registry credential"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="none">No Credential</SelectItem></SelectContent>
                  </Select>
                </div>
              </FormRow>
            </DialogBody>
          ) : (
            <DialogBody className="min-h-0 overflow-y-auto">
              <FormRow label="Source Code">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded border border-border bg-alpha-4 px-2.5">
                    <ServiceIcon service="docker" className="size-4 shrink-0" />
                    <span className="truncate text-sm">{ref}</span>
                  </div>
                  <Button type="button" variant="secondary" size="sm" onClick={() => setStep('source')}>Edit</Button>
                </div>
              </FormRow>
              <DialogDivider />
              <FormRow htmlFor="svc-docker-name" label="Service Name"
                hint={registered.current !== null
                  ? `${registered.current} already exists; submitting again retries the deploy onto it.`
                  : 'A unique name for your service.'}>
                <Input id="svc-docker-name" name="name" required autoFocus placeholder="api" value={name}
                  disabled={registered.current !== null}
                  onChange={(e) => { setNameEdited(true); setNameInput(e.target.value) }} />
              </FormRow>
              <DialogDivider />
              <FormRow htmlFor="svc-port" label="Port" hint="The port your app listens on.">
                <Input id="svc-port" name="port" inputMode="numeric" className="w-32" value={port} onChange={(e) => setPort(e.target.value)} />
              </FormRow>
              <AdvancedSettings open={advancedOpen} onOpenChange={setAdvancedOpen}>
                <AlwaysOnRow choice={choice} defaultOn={boot.alwaysOnDefault && isDefaultBranch === true} unreadable={unreadable} onPick={setPicked} />
                <VolumeFormRow enabled={volumeEnabled} onEnabledChange={setVolumeEnabled} sizeGib={volumeGib} onSizeChange={setVolumeGib} />
              </AdvancedSettings>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </DialogBody>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">Cancel</Button>
            </DialogClose>
            {step === 'source' ? (
              <Button type="submit" variant="primary" disabled={!ref}>Deploy</Button>
            ) : (
              <Button type="submit" variant="primary" disabled={!name.trim() || busy || !choice.known}>{busy ? 'Deploying…' : 'Add'}</Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
