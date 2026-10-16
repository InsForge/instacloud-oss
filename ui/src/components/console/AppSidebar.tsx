// The console's sidebar chrome (insta-frontend components/app-sidebar.tsx): a collapsible 240px
// rail with a pinned "Collapse Menu" footer on semantic-1. Collapse animates only the aside's
// width; every row keeps a constant inner width with the icon in a fixed 48px slot, so icons stay
// put and labels never reflow.

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '@insforge/ui'
import { PanelLeftClose, PanelLeftOpen, type LucideIcon } from 'lucide-react'
import { useLocalFlag } from '../../lib/localPref'

/** Shared by every sidebar and the topbar's collapsed-rail project switcher. */
export function useSidebarCollapsed(): [boolean, (collapsed: boolean) => void] {
  return useLocalFlag('insta:sidebar-collapsed')
}

export function AppSidebar({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  return (
    <aside
      className={cn(
        // The right edge is an overlay line, not a border, so over the alpha-8 active row it
        // stacks to a visibly darker seam instead of blending away.
        'relative flex shrink-0 flex-col overflow-x-hidden bg-semantic-1',
        'after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:z-10 after:w-px after:bg-border',
        'transition-[width] duration-200 ease-in-out',
        collapsed ? 'w-12' : 'w-60',
      )}
    >
      {children}
      <SidebarDivider />
      <div className="pb-2">
        <SidebarButton
          icon={collapsed ? PanelLeftOpen : PanelLeftClose}
          label={collapsed ? 'Expand Menu' : 'Collapse Menu'}
          onClick={() => setCollapsed(!collapsed)}
        />
      </div>
    </aside>
  )
}

/** Full-width hairline centered in a 20px zone. */
export function SidebarDivider() {
  return (
    <div className="flex h-5 w-full shrink-0 items-center">
      <div className="h-px w-full bg-border" />
    </div>
  )
}

function rowClass(active: boolean): string {
  return cn(
    'flex h-10 w-60 shrink-0 items-center text-sm transition-colors',
    active ? 'bg-alpha-8 font-medium text-foreground' : 'text-muted-foreground hover:bg-alpha-4 hover:text-foreground',
  )
}

function RowContent({ icon: Icon, label, badge }: { icon: LucideIcon; label: string; badge?: ReactNode }) {
  const [collapsed] = useSidebarCollapsed()
  return (
    <>
      <span className="flex w-12 shrink-0 items-center justify-center">
        <Icon className="size-5" />
      </span>
      <span className={cn('min-w-0 flex-1 truncate pr-3 text-left transition-opacity duration-200', collapsed && 'opacity-0')}>
        {label}
      </span>
      {badge && <span className={cn('mr-3 shrink-0', collapsed && 'opacity-0')}>{badge}</span>}
    </>
  )
}

export function SidebarLink({ to, icon, label, active = false, badge }: {
  to: string; icon: LucideIcon; label: string; active?: boolean; badge?: ReactNode
}) {
  const [collapsed] = useSidebarCollapsed()
  return (
    <Link to={to} title={collapsed ? label : undefined} className={rowClass(active)}>
      <RowContent icon={icon} label={label} badge={badge} />
    </Link>
  )
}

export function SidebarButton({ icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  const [collapsed] = useSidebarCollapsed()
  return (
    <button type="button" title={collapsed ? label : undefined} onClick={onClick} className={rowClass(false)}>
      <RowContent icon={icon} label={label} />
    </button>
  )
}
