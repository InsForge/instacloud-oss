// The console's row status (insta-frontend services/service-status.tsx): small text with a 6px dot,
// or a 16px icon for states in motion or in trouble. The state itself comes from lib/status.ts
// (the daemon's runtime-health view); this only draws it the console's way. Stopped and Suspended
// are self-host states the console has no word for, so they read as muted dots.

import { cn } from '@insforge/ui'
import { CircleAlert } from 'lucide-react'
import type { ServiceStatus } from '../../lib/status'
import { DeployingBadge } from './Tabs'

function Dot({ label, dot, text, title }: { label: string; dot: string; text: string; title?: string }) {
  return (
    <span className={cn('flex items-center gap-2 text-sm', text)} title={title}>
      <span className={cn('size-1.5 shrink-0 rounded-full', dot)} />
      {label}
    </span>
  )
}

export function ServiceStatusIndicator({ status }: { status: ServiceStatus }) {
  switch (status.kind) {
    case 'online':
      return <Dot label="Online" dot="bg-success" text="text-success" />
    case 'sleeping':
      return <Dot label="Sleeping" dot="bg-disabled" text="text-muted-foreground" title={status.title} />
    case 'starting':
      return <DeployingBadge />
    case 'waking':
      return <DeployingBadge label="Waking" />
    case 'crashed':
      return (
        <span className="flex items-center gap-2 text-sm text-destructive"
          title="The app is not answering on its port. Check the service logs.">
          <CircleAlert className="size-4" />
          Crashed
        </span>
      )
    case 'stopped':
    case 'suspended':
      return <Dot label={status.label} dot="bg-disabled" text="text-muted-foreground" title={status.title} />
    case 'none':
      return <Dot label="Not deployed" dot="bg-disabled" text="text-muted-foreground" />
    default:
      return <span className="text-sm text-muted-foreground">—</span>
  }
}
