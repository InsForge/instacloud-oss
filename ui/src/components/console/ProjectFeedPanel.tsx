// The console's shared right-hand panel (insta-frontend project-feed-panel-shell.tsx and
// lib/hooks/use-project-feed-panel.ts): Activities and Notifications take turns in one 320px column docked to
// the right of the content, pushing it aside rather than covering it. Which one is open is remembered per viewer
// under the console's key.

import { useEffect, useState, type ReactNode } from 'react'
import { useLocalPref } from '../../lib/localPref'
import { feedPanelFrom, type FeedPanel } from '../../lib/notifications'

/** The console's key; it also reads its older boolean "1" as Activities open. */
const PANEL_KEY = 'insta:activities-open'

export function useProjectFeedPanel(): [FeedPanel, (panel: FeedPanel) => void] {
  const [saved, setSaved] = useLocalPref(PANEL_KEY)
  return [feedPanelFrom(saved), (panel) => setSaved(panel)]
}

/** Keeps the closing content mounted until the width and slide transitions finish (the console's shell). */
export function FeedPanelShell({ open, label, children }: { open: boolean; label: string; children: ReactNode }) {
  const [previousOpen, setPreviousOpen] = useState(open)
  const [retained, setRetained] = useState(open)
  if (previousOpen !== open) {
    setPreviousOpen(open)
    if (open) setRetained(true)
  }
  useEffect(() => {
    if (open || !retained) return
    const timeout = window.setTimeout(() => setRetained(false), 300)
    return () => window.clearTimeout(timeout)
  }, [open, retained])

  if (!open && !retained) return null
  return (
    <div className="project-feed-panel-shell" data-open={open} aria-hidden={!open || undefined} inert={!open}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === 'width' && !open) setRetained(false)
      }}>
      <aside aria-label={label} className="project-feed-panel-content flex h-full w-80 flex-col border-l border-border bg-semantic-1">
        {children}
      </aside>
    </div>
  )
}
