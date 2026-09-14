// The console's topbar branch switcher (insta-frontend branches/env-switcher.tsx): a 200px cell naming
// the active branch with its badge, a menu of branches plus "Manage Branches", and a secondary
// "Add Branch" beside it. Switching navigates and keeps the page you are on.

import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@insforge/ui'
import { Check, ChevronDown, Plus, Settings2 } from 'lucide-react'
import { api, type BranchInfo } from '../../api'
import { usePoll } from '../../hooks'
import { envBadge, subpageForSwitch } from '../../lib/envSwitch'
import { ApprovalPrompt, type PendingApproval } from '../ApprovalPrompt'
import { CreateEnvironmentDialog } from './CreateEnvironmentDialog'

export function EnvStatusBadge({ env }: { env: BranchInfo }) {
  const { label, className } = envBadge(env)
  return <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium ${className}`}>{label}</span>
}

export function EnvSwitcher({ projectId, branch }: { projectId: string; branch: string }) {
  const nav = useNavigate()
  const { pathname } = useLocation()
  const [createOpen, setCreateOpen] = useState(false)
  const [approval, setApproval] = useState<PendingApproval>(null)
  const { data: all = [], reload } = usePoll(() => api.branches(projectId), [projectId], 15_000)
  // The trigger says where you are, even on a branch that failed; the menu offers only somewhere you
  // can go.
  const active = all.find((env) => env.name === branch) ?? null
  const branches = all.filter((env) => envBadge(env).label !== 'Failed')

  return (
    <div className="flex h-full items-center gap-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" disabled={!active}
            className="flex h-full w-50 shrink-0 items-center gap-2 border-r border-border px-3 text-left transition-colors hover:bg-alpha-4 disabled:opacity-60 data-[state=open]:bg-alpha-8">
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {active ? (
                <>
                  <span className="truncate text-sm">{active.name}</span>
                  <span className="shrink-0"><EnvStatusBadge env={active} /></span>
                </>
              ) : (
                <span className="truncate text-sm text-muted-foreground">No branches</span>
              )}
            </span>
            <ChevronDown className="size-5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <div className="max-h-78 overflow-y-auto">
            {branches.map((env) => (
              <DropdownMenuItem key={env.id}
                onSelect={() => nav(`/p/${projectId}/${encodeURIComponent(env.name)}/${subpageForSwitch(pathname)}`)}>
                <Check className={env.name === branch ? 'size-4 shrink-0' : 'invisible size-4 shrink-0'} />
                <span className="flex-1 truncate">{env.name}</span>
                <EnvStatusBadge env={env} />
              </DropdownMenuItem>
            ))}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => nav(`/p/${projectId}/${branch}/branches`)}>
            <Settings2 className="size-4 shrink-0" />
            Manage Branches
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button variant="secondary" size="sm" className="h-9 gap-1.5 text-muted-foreground hover:text-primary"
        onClick={() => setCreateOpen(true)}>
        <Plus className="size-4" />
        Add Branch
      </Button>

      <CreateEnvironmentDialog projectId={projectId} environments={all} open={createOpen} onOpenChange={setCreateOpen}
        onCreated={(name) => { reload(); nav(`/p/${projectId}/${encodeURIComponent(name)}/services`) }} onApproval={setApproval} />
      <ApprovalPrompt projectId={projectId} pending={approval} onClose={() => setApproval(null)} />
    </div>
  )
}
