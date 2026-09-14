import { useParams } from 'react-router-dom'
import { cn } from '@insforge/ui'
import { api, relTime } from '../api'
import { usePoll } from '../hooks'
import { ConsolePage } from '../components/console/ConsolePage'

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase()
  const className =
    s === 'finished' || s === 'success' ? 'bg-success/10 text-success'
    : s === 'failed' || s === 'error' || s === 'cancelled' ? 'bg-destructive/10 text-destructive'
    : 'bg-warning/10 text-warning'
  return <span className={cn('rounded-md px-1.5 py-0.5 text-xs font-medium', className)}>{status}</span>
}

/** The project's control-plane operation log — resource lifecycle actions, newest first. */
export function Operations() {
  const { projectId } = useParams() as { projectId: string }
  const { data: operations, error } = usePoll(() => api.operations(projectId), [projectId], 10000)

  return (
    <ConsolePage title="Operations"
      subtitle="Control-plane operations across all branches — provisioning, deploys, and lifecycle changes, newest first">

      {error && (
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-destructive">{error.message}</div>
      )}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <table className="w-full table-fixed">
          <thead>
            <tr className="border-b border-border">
              <th className="w-40 px-4 py-3 text-left text-[13px] font-normal text-muted-foreground">Time</th>
              <th className="px-4 py-3 text-left text-[13px] font-normal text-muted-foreground">Action</th>
              <th className="w-32 px-4 py-3 text-left text-[13px] font-normal text-muted-foreground">Status</th>
            </tr>
          </thead>
          <tbody>
            {!operations?.length ? (
              <tr>
                <td colSpan={3} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No operations yet.
                </td>
              </tr>
            ) : (
              operations.map((op) => (
                <tr key={op.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2.5 text-[13px] text-muted-foreground" title={op.createdAt}>
                    {relTime(op.createdAt)}
                  </td>
                  <td className="truncate px-4 py-2.5 font-mono text-[13px]">{op.action}</td>
                  <td className="px-4 py-2.5"><StatusBadge status={op.status} /></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </ConsolePage>
  )
}
