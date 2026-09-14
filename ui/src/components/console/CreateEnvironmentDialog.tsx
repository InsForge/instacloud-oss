// The console's "Add Branch" dialog (insta-frontend branches/create-branch-dialog.tsx): name and the
// branch to branch from, in label-left rows. Self-host divergences: no "Exclude all services" (the
// daemon always forks the parent), and the create is awaited here rather than handed off, because a
// self-hosted fork takes seconds, not minutes.

import { useState, type FormEvent } from 'react'
import {
  Button, Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@insforge/ui'
import { api, type BranchInfo } from '../../api'
import type { PendingApproval } from '../ApprovalPrompt'
import { BRANCH_NAME_RE, LOWER_KEBAB_BRANCH_ERROR } from '../../lib/serviceNames'

export function CreateEnvironmentDialog({ projectId, environments, open, onOpenChange, onCreated, onApproval }: {
  projectId: string; environments: BranchInfo[]; open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (name: string) => void
  onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  // Only a usable branch can be forked.
  const parents = environments.filter((env) => env.status !== 'cleanup-failed' && env.status !== 'error')
  const defaultParent = parents.find((env) => env.is_default)?.name ?? parents[0]?.name ?? 'main'
  const [name, setName] = useState('')
  const [from, setFrom] = useState(defaultParent)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => { setName(''); setFrom(defaultParent); setError(null); setBusy(false) }

  const create = async (next: string) => {
    setBusy(true)
    const r = await api.createBranch(projectId, next, from)
    setBusy(false)
    if (r.kind === 'error') return setError(r.error)
    // Close only on success. Closing before handing off to the approval prompt meant a retry that
    // failed after the grant wrote setError into an unmounted dialog, and the user saw nothing.
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void create(next) } })
    onOpenChange(false); reset()
    onCreated(next)
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    const next = name.trim()
    if (!next) return
    // The name becomes part of every URL and hostname for the branch, so it carries the same
    // lower-kebab rule the daemon enforces. Checked here too, for the error next to the field
    // rather than a round trip.
    if (!BRANCH_NAME_RE.test(next)) return setError(LOWER_KEBAB_BRANCH_ERROR)
    if (environments.some((env) => env.name === next)) return setError('A branch with this name already exists.')
    void create(next)
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { onOpenChange(nextOpen); if (!nextOpen) reset() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Branch</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit}>
          <DialogBody className="flex flex-col gap-4">
            <div className="flex items-center gap-6">
              <label htmlFor="branch-name" className="w-32 shrink-0 text-sm">Branch Name</label>
              <Input id="branch-name" name="name" autoFocus placeholder="staging" value={name}
                onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex items-center gap-6">
              <span className="w-32 shrink-0 text-sm">Branch from</span>
              <div className="min-w-0 flex-1">
                <Select value={from} onValueChange={setFrom}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {parents.map((env) => <SelectItem key={env.id} value={env.name}>{env.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={!name.trim() || busy}>{busy ? 'Creating…' : 'Create'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
