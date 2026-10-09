// The console's service dialogs (insta-frontend services/rename-service-dialog.tsx,
// restart-service-dialog.tsx, delete-service-dialog.tsx). Self-host divergence: the console stages
// rename and delete into its apply-changes batch; the daemon applies them now, so the delete copy
// says it cannot be undone and its button says Delete rather than "Delete on Deploy".

import { useState, type FormEvent } from 'react'
import {
  Button, ConfirmDialog, Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input,
} from '@insforge/ui'
import { api, type Service } from '../../api'
import type { PendingApproval } from '../ApprovalPrompt'
import { LOWER_KEBAB_NAME_ERROR, SERVICE_NAME_RE } from '../../lib/serviceNames'
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'

export type ServiceDialogProps = {
  projectId: string; branch: string; service: Service
  open: boolean; onOpenChange: (open: boolean) => void
  onDone: () => void; onError: (message: string) => void; onApproval: (p: NonNullable<PendingApproval>) => void
}

export function RenameServiceDialog({ projectId, branch, service, open, onOpenChange, onDone, onApproval }: ServiceDialogProps) {
  const [name, setName] = useState(service.name)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const rename = async (next: string) => {
    setBusy(true)
    const r = await api.renameService(projectId, service.id, next, branch)
    setBusy(false)
    if (r.kind === 'error') return setError(r.status === 409 ? `A service named ${next} already exists.` : r.error)
    // Close only on success: closing before the approval hand-off sent a failed retry's error to
    // an unmounted dialog.
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void rename(next) } })
    onOpenChange(false)
    onDone()
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    const next = name.trim()
    if (next === service.name) return onOpenChange(false)
    if (!SERVICE_NAME_RE.test(next)) return setError(LOWER_KEBAB_NAME_ERROR)
    void rename(next)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename Service</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit}>
          <DialogBody className="flex flex-col gap-2">
            <div className="flex items-center gap-6">
              <label htmlFor="service-name" className="w-32 shrink-0 text-sm">Service Name</label>
              <Input id="service-name" name="name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={busy}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Put a new image on a compute service that already exists. `POST /deploy` has always handled
 *  both the first deploy and a redeploy, but the Add Service flow only ever reaches it for a
 *  service it just registered, which left no way to update a running app's image from the
 *  dashboard, and no way to finish a deploy that failed after registration. */
export function DeployImageDialog({ projectId, branch, service, open, onOpenChange, onDone, onApproval }: ServiceDialogProps) {
  const [image, setImage] = useState(service.image ?? '')
  const [port, setPort] = useState(String(service.port ?? 80))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const deploy = async (ref: string, portNum: number) => {
    setBusy(true)
    const d = await api.deployImage(projectId, { image: ref, port: portNum, group: service.name, branch })
    setBusy(false)
    if (d.kind === 'error') return setError(d.error)
    if (d.kind === 'approval') return onApproval({ ...d, retry: () => { void deploy(ref, portNum) } })
    onOpenChange(false)
    onDone()
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    const ref = image.trim()
    if (!ref) return setError('An image reference is required.')
    const portNum = Number(port)
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return setError('Port must be a whole number between 1 and 65535.')
    }
    void deploy(ref, portNum)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deploy Image</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit}>
          <DialogBody className="flex flex-col gap-2">
            <div className="flex items-center gap-6">
              <label htmlFor="deploy-image" className="w-32 shrink-0 text-sm">Image</label>
              <Input id="deploy-image" name="image" required autoFocus placeholder="nginx:alpine"
                value={image} onChange={(e) => setImage(e.target.value)} />
            </div>
            <div className="flex items-center gap-6">
              <label htmlFor="deploy-port" className="w-32 shrink-0 text-sm">Port</label>
              <Input id="deploy-port" name="port" required inputMode="numeric"
                value={port} onChange={(e) => setPort(e.target.value)} />
            </div>
            <p className="text-sm text-muted-foreground">
              Replaces what <span className="font-medium text-foreground">{service.name}</span> is running. Its database,
              bucket and volume are untouched.
            </p>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={busy}>Deploy</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Fire-and-return, like the console: the row's status shows the restart, not a held modal. */
export function RestartServiceDialog({ projectId, branch, service, open, onOpenChange, onDone, onError, onApproval }: ServiceDialogProps) {
  const restart = async () => {
    const r = await api.lifecycle(projectId, service.id, 'restart', branch)
    if (r.kind === 'error') return onError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void restart() } })
    onDone()
  }
  return (
    <ConfirmDialog open={open} onOpenChange={onOpenChange} title="Restart Service" confirmText="Restart" destructive
      description="Are you sure you want to restart this deployment? This will restart your container."
      onConfirm={() => { void restart() }} />
  )
}

export function DeleteServiceDialog({ projectId, branch, service, open, onOpenChange, onDone, onError, onApproval }: ServiceDialogProps) {
  const remove = async () => {
    const r = await api.removeService(projectId, service.id, branch)
    if (r.kind === 'error') return onError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void remove() } })
    onDone()
  }
  return (
    <ConfirmDeleteDialog open={open} onOpenChange={onOpenChange} title="Delete Service" name={service.name} confirmText="Delete"
      description={
        <span>
          This permanently deletes <span className="font-semibold text-foreground">{service.name}</span> along with its data and
          removes it from this branch. This cannot be undone.
        </span>
      }
      onConfirm={remove} />
  )
}
