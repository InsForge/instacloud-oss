import { useState } from 'react'
import { Button } from '@insforge/ui'
import { api, type ApiResult } from '../api'
import { ErrorNote, Modal } from './ui'

export type PendingApproval = { action: string; approvalId: string; retry: () => void } | null

/** Shared HITL modal: any mutation that came back 202 lands here; granting retries the mutation
 *  (grants are one-shot server-side, mirroring the CLI's `insta agent approvals approve` flow). */
export function ApprovalPrompt({ projectId, pending, onClose }: {
  projectId: string; pending: PendingApproval; onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (!pending) return null

  const decide = async (verdict: 'approve' | 'deny', always = false) => {
    setBusy(true)
    setError(undefined)
    const r: ApiResult<unknown> = await api.decide(projectId, pending.approvalId, verdict, always)
    setBusy(false)
    if (r.kind === 'error') return setError(r.error)
    onClose()
    if (verdict === 'approve') pending.retry()
  }

  return (
    <Modal
      title="Approval required"
      onClose={onClose}
      footer={
        <>
          <Button variant="destructive" onClick={() => decide('deny')} disabled={busy}>Deny</Button>
          <Button variant="secondary" onClick={() => decide('approve', true)} disabled={busy}>Grant always</Button>
          <Button variant="primary" onClick={() => decide('approve')} disabled={busy}>Grant once</Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        Policy gates <code className="rounded bg-semantic-1 px-1 font-mono text-[13px] text-foreground">{pending.action}</code> behind
        a human decision. Grant it to run this action once, or grant always to stop asking.
      </p>
      <ErrorNote error={error} />
    </Modal>
  )
}
