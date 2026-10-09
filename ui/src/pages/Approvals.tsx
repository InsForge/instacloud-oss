import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { Button, cn } from '@insforge/ui'
import { api, relTime } from '../api'
import { usePoll } from '../hooks'
import { ErrorNote } from '../components/ui'
import { ConsolePage } from '../components/console/ConsolePage'

export function Approvals() {
  const { projectId } = useParams() as { projectId: string }
  const { data: approvals, reload } = usePoll(() => api.approvals(projectId), [projectId], 3000)
  const [error, setError] = useState<string>()

  const decide = async (id: string, verdict: 'approve' | 'deny', always = false) => {
    setError(undefined)
    const r = await api.decide(projectId, id, verdict, always)
    if (r.kind === 'error') return setError(r.error)
    reload()
  }

  const pending = (approvals ?? []).filter((a) => a.status === 'pending')
  const decided = (approvals ?? []).filter((a) => a.status !== 'pending').slice(-10).reverse()

  return (
    <ConsolePage title="Approvals"
      subtitle="Actions your policy gates behind a human. Grants are one-shot: the requester retries and consumes it.">

      {pending.length === 0 && (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          Nothing pending — gated actions will queue here.
        </p>
      )}
      <div className="flex flex-col gap-2">
        {pending.map((a) => (
          <div key={a.id} className="flex items-center rounded-lg border border-warning/40 bg-warning/5 px-4 py-3">
            <div>
              <code className="font-mono text-sm font-medium">{a.action}</code>
              <p className="text-xs text-muted-foreground">requested {relTime(a.requested_at)}</p>
            </div>
            <div className="ml-auto flex gap-2">
              <Button variant="destructive" size="sm" onClick={() => decide(a.id, 'deny')}>Deny</Button>
              <Button variant="secondary" size="sm" onClick={() => decide(a.id, 'approve', true)}>Grant always</Button>
              <Button variant="primary" size="sm" onClick={() => decide(a.id, 'approve')}>Grant once</Button>
            </div>
          </div>
        ))}
      </div>
      <ErrorNote error={error} />

      {decided.length > 0 && (
        <>
          <h2 className="mt-6 text-sm font-semibold text-muted-foreground">Recent decisions</h2>
          <div className="flex flex-col gap-1">
            {decided.map((a) => (
              <div key={a.id} className="flex items-center px-4 py-1.5 text-sm text-muted-foreground">
                <code className="font-mono text-[13px]">{a.action}</code>
                <span className={cn('ml-3 text-xs', a.status === 'denied' ? 'text-destructive' : 'text-success')}>{a.status}</span>
                <span className="ml-auto text-xs">{relTime(a.decided_at ?? a.requested_at)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </ConsolePage>
  )
}
