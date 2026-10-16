// The console's compute Volume tab (insta-frontend volumes/service-volume-tab.tsx, volume-card.tsx,
// volume-size-field.tsx): one card titled Volume with an Attach Volume switch, and under it the Mount Path and a Size
// row that reads as text until its pencil is pressed.
//
// Self-host divergences:
// - Nothing is staged for Deploy: the daemon applies a volume change on the spot. So the switch alone never writes.
//   Turning it on opens the Size row with an Attach Volume button; turning it off asks before the delete, because the
//   delete destroys the data on every branch and is gated like removing the service.
// - No Used row: the daemon reports no disk series, and a made-up zero would read as "measured, and empty".
// - No Region row (one machine) and no Upgrade Plan (no plans); the cap is the daemon's fixed ceiling.

import { useState } from 'react'
import { Button, ConfirmDialog, Input, Skeleton, Switch } from '@insforge/ui'
import { Pencil } from 'lucide-react'
import { api, type Service } from '../../api'
import { usePoll } from '../../hooks'
import { formatVolumeGib, sizeBounds, sizeError } from '../../lib/volumeSize'
import type { PendingApproval } from '../ApprovalPrompt'
import { ErrorNote } from '../ui'
import { SettingsDivider, SettingsRow } from './SettingsRow'

export function VolumeCard({ projectId, branch, service, onApproval }: {
  projectId: string; branch: string; service: Service
  onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const { data, error, reload } = usePoll(
    () => api.volume(projectId, service.id, branch),
    [projectId, service.id, branch],
    { intervalMs: 30000 },
  )
  // `attaching` is the switch turned on over no disk: the Size row is open, nothing is written yet.
  const [attaching, setAttaching] = useState(false)
  // The size under edit, as typed; null is the at-rest text.
  const [draft, setDraft] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()

  if (!data && !error) {
    return (
      <div className="flex flex-col rounded-lg border border-border bg-card p-4">
        <Skeleton className="h-8 w-full max-w-md" />
      </div>
    )
  }
  if (!data) {
    return (
      <div className="flex flex-col rounded-lg border border-border bg-card p-4">
        <h2 className="pb-2 text-base font-medium">Volume</h2>
        <p className="py-3 text-sm text-muted-foreground">This service&apos;s volume isn&apos;t readable yet.</p>
        <ErrorNote error={error} />
      </div>
    )
  }

  const attached = data.volume
  const cap = data.cap.volumeGib
  const bounds = sizeBounds(attached, cap)
  const on = attached !== null || attaching
  // An attach opens straight into the picker, at the console's starting size: the cap.
  const text = draft ?? (attached ? String(attached.sizeGib) : String(cap))
  const editing = draft !== null || (attached === null && attaching)
  const invalid = editing ? sizeError(text, bounds) : null

  const save = async () => {
    if (invalid) return
    setBusy(true); setActionError(undefined)
    const r = await api.setVolume(projectId, service.id, Number(text.trim()), branch)
    setBusy(false)
    if (r.kind === 'error') return setActionError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void save() } })
    setDraft(null); setAttaching(false)
    reload()
  }

  const remove = async () => {
    setBusy(true); setActionError(undefined)
    const r = await api.removeVolume(projectId, service.id, branch)
    setBusy(false); setConfirmDelete(false)
    if (r.kind === 'error') return setActionError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void remove() } })
    setDraft(null)
    reload()
  }

  const toggle = (next: boolean) => {
    setActionError(undefined)
    if (attached) {
      if (!next) setConfirmDelete(true)
      return
    }
    setAttaching(next)
    setDraft(null)
  }

  return (
    <div className="flex flex-col rounded-lg border border-border bg-card p-4">
      <h2 className="pb-2 text-base font-medium">Volume</h2>

      <SettingsRow label="Attach Volume">
        <div className="flex min-h-8 items-center">
          <Switch checked={on} disabled={busy} aria-label="Attach volume" onCheckedChange={toggle} />
        </div>
      </SettingsRow>

      {attached && (
        <>
          <SettingsDivider />
          <SettingsRow label="Mount Path" hint="Where the volume is mounted inside the service.">
            <div className="flex min-h-8 items-center font-mono text-[13px]">{attached.mountPath}</div>
          </SettingsRow>
        </>
      )}

      {on && (
        <>
          <SettingsDivider />
          <SettingsRow label="Size"
            hint="The maximum size of the volume. It is recorded here; a local disk has no quota, so free space on the daemon's data volume is the real limit.">
            <div className="flex flex-col gap-2">
              {editing ? (
                <div className="flex min-h-8 flex-wrap items-center gap-2">
                  <Input type="number" aria-label="Volume size" className="w-28" min={bounds.floor} max={bounds.max} step={1}
                    autoFocus value={text} disabled={busy} onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void save() }} />
                  <span className="text-[13px] text-muted-foreground">GB</span>
                  <Button variant="primary" size="sm" disabled={busy || !!invalid} onClick={() => { void save() }}>
                    {attached ? 'Save' : 'Attach Volume'}
                  </Button>
                  <Button variant="secondary" size="sm" disabled={busy}
                    onClick={() => { setDraft(null); if (!attached) setAttaching(false) }}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium tabular-nums">{formatVolumeGib(attached!.sizeGib)}</span>
                  <Button variant="ghost" size="icon-sm" aria-label="Edit volume size" disabled={busy || bounds.atCeiling}
                    onClick={() => setDraft(String(attached!.sizeGib))}>
                    <Pencil className="size-4 text-muted-foreground" />
                  </Button>
                  <span className="text-[13px] text-muted-foreground tabular-nums">Up to {formatVolumeGib(bounds.max)}</span>
                </div>
              )}
              {invalid && <p className="text-[13px] text-destructive">{invalid}</p>}
              <p className="text-[13px] text-muted-foreground">
                {attached
                  ? 'A volume can only grow; a provisioned disk cannot shrink.'
                  : 'The volume mounts at /data on the next deploy. It cannot be shrunk, and deleting it later destroys its data too.'}
              </p>
            </div>
          </SettingsRow>
        </>
      )}

      <ErrorNote error={actionError ?? error} />

      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete Volume"
        description={`Deleting ${service.name}'s volume destroys its data on every branch and redeploys it without the mount. This cannot be undone.`}
        confirmText="Delete Volume" destructive isLoading={busy} onConfirm={() => { void remove() }} />
    </div>
  )
}
