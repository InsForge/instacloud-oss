// The console's two tab forms: SideTabs, the vertical rail of the service detail
// (insta-frontend side-tabs.tsx), and TopTabs, the underlined bar inside a tab (top-tabs.tsx).

import { cn } from '@insforge/ui'
import { RefreshCw } from 'lucide-react'
import type { KeyboardEvent } from 'react'

// A tablist is ONE tab stop, not one per tab (WAI-ARIA's roving tabindex): Tab enters the list at
// the selected tab and the next Tab leaves it, while the arrow keys move within. Leaving every tab
// in the normal order made Tab walk all of them before reaching the panel, which in the service
// modal is the primary navigation and the thing a keyboard user hits first.
function useRoving<T extends string>(tabs: readonly { id: T }[], value: T, onChange: (id: T) => void) {
  const prevNext = (e: KeyboardEvent<HTMLDivElement>, prev: string, next: string) => {
    const step = e.key === next ? 1 : e.key === prev ? -1 : e.key === 'Home' ? -Infinity : e.key === 'End' ? Infinity : 0
    if (!step) return
    e.preventDefault()
    const i = tabs.findIndex((t) => t.id === value)
    const to = step === -Infinity ? 0 : step === Infinity ? tabs.length - 1
      : (i + step + tabs.length) % tabs.length
    const target = tabs[to]
    if (!target) return
    onChange(target.id)
    // Selection follows focus, so move focus with it or the next arrow key reads the old position.
    const list = e.currentTarget
    requestAnimationFrame(() => list.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus())
  }
  return prevNext
}

export function SideTabs<T extends string>({ tabs, value, onChange, className, panelId }: {
  tabs: readonly { id: T; label: string }[]; value: T; onChange: (id: T) => void; className?: string; panelId?: string
}) {
  const roving = useRoving(tabs, value, onChange)
  return (
    <div role="tablist" aria-orientation="vertical" className={cn('flex w-50 shrink-0 flex-col', className)}
      onKeyDown={(e) => roving(e, 'ArrowUp', 'ArrowDown')}>
      {tabs.map(({ id, label }) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} tabIndex={value === id ? 0 : -1}
          id={panelId ? `${panelId}-tab-${id}` : undefined} aria-controls={panelId} onClick={() => onChange(id)}
          className={cn('flex h-10 items-center px-4 text-left text-sm transition-colors',
            value === id ? 'bg-card font-medium text-foreground' : 'text-muted-foreground hover:bg-alpha-4 hover:text-foreground')}>
          {label}
        </button>
      ))}
    </div>
  )
}

export function TopTabs<T extends string>({ tabs, value, onChange, label, className, panelId }: {
  tabs: readonly { id: T; label: string }[]; value: T; onChange: (id: T) => void; label: string
  className?: string; panelId?: string
}) {
  const roving = useRoving(tabs, value, onChange)
  return (
    <div role="tablist" aria-label={label} className={cn('flex items-center gap-6 border-b border-border', className)}
      onKeyDown={(e) => roving(e, 'ArrowLeft', 'ArrowRight')}>
      {tabs.map(({ id, label: tabLabel }) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} tabIndex={value === id ? 0 : -1}
          id={panelId ? `${panelId}-tab-${id}` : undefined} aria-controls={panelId} onClick={() => onChange(id)}
          className="flex flex-col items-center gap-3 pt-1 outline-none focus-visible:ring-2">
          <span className={cn('text-[13px] transition-colors', value === id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}>
            {tabLabel}
          </span>
          <span aria-hidden className={cn('h-0.5 w-full', value === id ? 'bg-foreground' : 'bg-transparent')} />
        </button>
      ))}
    </div>
  )
}

/** Live-progress row status: a spinner, not a dot (the console's DeployingBadge). */
export function DeployingBadge({ label = 'Deploying' }: { label?: string }) {
  return (
    <span className="flex items-center gap-2 text-sm text-info">
      <RefreshCw className="size-4 animate-spin" />
      {label}
    </span>
  )
}
