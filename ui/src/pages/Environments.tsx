// The console's Branches page (insta-frontend branches/branches-view.tsx, branch-actions-menu.tsx): a
// title band with Add Branch, then a table of Branch, Status, Service (type icons), Created. The default
// branch has no menu (it cannot be deleted). Self-host divergences: no Rename Branch (the daemon has no
// branch rename), no GitHub deployments panel, and no Agent Governance column (the daemon's governance
// policy is project-wide, so there is no per-branch protection to show).

import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  Button, ConfirmDialog, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@insforge/ui'
import { CircleAlert, EllipsisVertical, Plus } from 'lucide-react'
import { api, type BranchInfo } from '../api'
import { usePoll } from '../hooks'
import { envBadge } from '../lib/envSwitch'
import { ApprovalPrompt, type PendingApproval } from '../components/ApprovalPrompt'
import { CreateEnvironmentDialog } from '../components/console/CreateEnvironmentDialog'
import { EnvStatusBadge } from '../components/console/EnvSwitcher'
import { ServiceTypeIcon } from '../components/console/ServiceIcon'
import { formatDateTime } from '../lib/format'
import { ErrorNote } from '../components/ui'

function Th({ children }: { children?: string }) {
  return <th className="px-4 py-3 text-left text-[13px] font-normal text-muted-foreground">{children}</th>
}

/** One icon per service type the branch carries.
 *
 *  The types come from the ONE `GET /projects/:id` the page already makes, exactly as the console
 *  builds this table (it derives a branch's services by matching `resource.branchId`). This used to be
 *  a `GET /services` poll per row, so opening a project with N branches fired N requests of
 *  Docker-backed work, repeatedly, just to draw icons. */
function ServiceIcons({ types }: { types: string[] }) {
  if (types.length === 0) return <span className="text-sm text-muted-foreground">—</span>
  return (
    <div className="flex items-center gap-2">
      {types.map((type) => (
        <span key={type} className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-semantic-1">
          <ServiceTypeIcon type={type} className="size-5" />
        </span>
      ))}
    </div>
  )
}

function BranchActionsMenu({ projectId, env, onDeleted, onError, onApproval }: {
  projectId: string; env: BranchInfo; onDeleted: () => void
  onError: (m: string) => void; onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const remove = async () => {
    setBusy(true)
    const r = await api.deleteBranch(projectId, env.id)
    setBusy(false)
    setDeleteOpen(false)
    if (r.kind === 'error') return onError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void remove() } })
    onDeleted()
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${env.name}`}>
            <EllipsisVertical className="size-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleteOpen(true)}>
            Delete Branch
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} title="Delete Branch"
        description={
          <span>
            This permanently deletes <span className="font-medium">{env.name}</span> and tears down its database branch,
            storage fork, and compute. This action cannot be undone.
          </span>
        }
        confirmText="Delete" cancelText="Cancel" destructive isLoading={busy} onConfirm={() => { void remove() }} />
    </>
  )
}

export function Environments() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  const nav = useNavigate()
  // One call for the branches AND what each carries, like the console's Branches table.
  const { data: detail, reload } = usePoll(() => api.projectDetail(projectId), [projectId])
  const envs = detail?.branches
  const typesByBranch = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const r of detail?.resources ?? []) {
      const seen = m.get(r.branchId) ?? []
      if (!seen.includes(r.kind)) m.set(r.branchId, [...seen, r.kind])
    }
    return m
  }, [detail])
  const [createOpen, setCreateOpen] = useState(false)
  const [approval, setApproval] = useState<PendingApproval>(null)
  const [error, setError] = useState<string>()
  const all = envs ?? []
  const defaultEnv = all.find((e) => e.is_default)?.name ?? 'main'

  return (
    <div className="-mx-8 -mt-8 flex w-auto flex-col gap-4">
      <div className="px-6">
        <div className="flex items-center justify-between gap-3 py-4.5">
          <h1 className="text-[32px] leading-12 font-semibold">Branches</h1>
          <Button variant="primary" className="h-9 gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            Add Branch
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-4 px-6">
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <Th>Branch</Th>
                <Th>Status</Th>
                <Th>Service</Th>
                <Th>Created</Th>
                <th className="w-12" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {all.map((env) => {
                // A branch whose teardown failed keeps its row so the delete can be retried; nothing
                // inside it works, so it does not open, but it keeps its menu.
                const failed = envBadge(env).label === 'Failed'
                return (
                  <tr key={env.id} onClick={failed ? undefined : () => nav(`/p/${projectId}/${encodeURIComponent(env.name)}/services`)}
                    className={cn('border-b border-border transition-colors last:border-b-0',
                      failed ? 'opacity-60' : 'cursor-pointer hover:bg-alpha-4')}>
                    {/* The row click is a convenience; this link is what keyboard and screen-reader
                        users navigate with, since a tr onClick reaches neither. */}
                    <td className="px-4 py-3 text-sm">
                      {failed ? env.name : (
                        <Link to={`/p/${projectId}/${encodeURIComponent(env.name)}/services`}
                          className="hover:underline" onClick={(e) => e.stopPropagation()}>
                          {env.name}
                        </Link>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {failed ? (
                        <span className="flex items-center gap-2 text-sm text-destructive"
                          title="This branch could not be torn down. Delete it again to retry.">
                          <CircleAlert className="size-4" />
                          Failed
                        </span>
                      ) : (
                        <EnvStatusBadge env={env} />
                      )}
                    </td>
                    <td className="px-4 py-3"><ServiceIcons types={typesByBranch.get(env.id) ?? []} /></td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{formatDateTime(env.created_at)}</td>
                    {env.is_default ? (
                      <td className="w-12" />
                    ) : (
                      <td className="px-2 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                        <BranchActionsMenu projectId={projectId} env={env} onError={setError} onApproval={setApproval}
                          onDeleted={() => {
                            reload()
                            // The branch you were standing on is gone: land on the default one.
                            if (env.name === branch) nav(`/p/${projectId}/${defaultEnv}/branches`, { replace: true })
                          }} />
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <ErrorNote error={error} />
      </div>

      <CreateEnvironmentDialog projectId={projectId} environments={all} open={createOpen} onOpenChange={setCreateOpen}
        onCreated={(name) => { reload(); nav(`/p/${projectId}/${name}/services`) }} onApproval={setApproval} />
      <ApprovalPrompt projectId={projectId} pending={approval} onClose={() => setApproval(null)} />
    </div>
  )
}
