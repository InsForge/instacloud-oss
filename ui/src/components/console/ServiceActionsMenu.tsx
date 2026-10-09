// The console's row kebab (insta-frontend services/service-actions-menu.tsx): Rename Service,
// Restart Service (compute only), Delete Service. Restart sits between the two on purpose, moving
// Delete further from Rename; like Delete, it is styled destructive. Self-host divergences: the console stages
// rename and delete into its apply-changes batch, while the daemon applies them immediately, so the dialogs call
// the API directly; and a compute service leads with Deploy Image, since the daemon deploys an image directly
// where the console deploys through that batch.

import { useState } from 'react'
import { Button, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@insforge/ui'
import { EllipsisVertical } from 'lucide-react'
import type { Service } from '../../api'
import type { PendingApproval } from '../ApprovalPrompt'
import { DeleteServiceDialog, DeployImageDialog, RenameServiceDialog, RestartServiceDialog } from './ServiceDialogs'

export function ServiceActionsMenu({ projectId, branch, service, onDone, onError, onApproval, iconClassName = 'size-4 text-muted-foreground' }: {
  projectId: string; branch: string; service: Service
  onDone: () => void; onError: (message: string) => void; onApproval: (p: NonNullable<PendingApproval>) => void
  iconClassName?: string
}) {
  const [deployOpen, setDeployOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [restartOpen, setRestartOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const common = { projectId, branch, service, onDone, onError, onApproval }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${service.name}`}
            className="group hover:bg-alpha-4 data-[state=open]:bg-alpha-4">
            <EllipsisVertical className={cn(iconClassName, 'group-hover:text-primary')} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {service.type === 'compute' && (
            <DropdownMenuItem onSelect={() => setDeployOpen(true)}>Deploy Image</DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setRenameOpen(true)}>Rename Service</DropdownMenuItem>
          {service.type === 'compute' && (
            <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setRestartOpen(true)}>Restart Service</DropdownMenuItem>
          )}
          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleteOpen(true)}>
            Delete Service
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {deployOpen && <DeployImageDialog {...common} open={deployOpen} onOpenChange={setDeployOpen} />}
      {renameOpen && <RenameServiceDialog {...common} open={renameOpen} onOpenChange={setRenameOpen} />}
      {restartOpen && <RestartServiceDialog {...common} open={restartOpen} onOpenChange={setRestartOpen} />}
      {deleteOpen && <DeleteServiceDialog {...common} open={deleteOpen} onOpenChange={setDeleteOpen} />}
    </>
  )
}
