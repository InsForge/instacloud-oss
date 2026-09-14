// The console's topbar Activities control and its side panel (insta-frontend activities-panel.tsx and
// project-feed-panel-shell.tsx): an icon cell that toggles a 320px column docked to the right of the
// content, listing the project's events as cards, newest first. Open or closed is remembered per viewer
// under the console's key, and the events are fetched only while the panel is open.
//
// Self-host divergence: the daemon ENFORCES approvals, which the console surfaces through a separate
// Notifications bell. Until that bell exists here, a pending count rides the Activities icon and the
// panel leads with a card that opens Approvals. The count is polled once, by the layout that mounts both.

import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button, cn, Skeleton } from '@insforge/ui'
import { X } from 'lucide-react'
import { api } from '../../api'
import { usePoll } from '../../hooks'
import { useLocalPref } from '../../lib/localPref'
import { ACTIVITY_PAGE_SIZE, mapEvents, panelState, type ActivityEvent } from '../../lib/activity'

/** The console's key; it also reads its older boolean "1" as open. */
const PANEL_KEY = 'insta:activities-open'

function useActivitiesOpen(): [boolean, (open: boolean) => void] {
  const [saved, setSaved] = useLocalPref(PANEL_KEY)
  return [saved === 'activities' || saved === '1', (open) => setSaved(open ? 'activities' : null)]
}

/** Icon-only header cell, matching the account control beside it. */
export function ActivitiesButton({ pending }: { pending: number }) {
  const [open, setOpen] = useActivitiesOpen()
  return (
    <div className="flex h-full shrink-0 items-center justify-center border-l border-border p-2">
      <Button variant="ghost" size="icon"
        className={cn('relative size-8 p-1.5 text-muted-foreground hover:text-foreground', open && 'bg-alpha-8 text-foreground')}
        aria-pressed={open}
        aria-label={pending ? `Activities, ${pending} approval${pending === 1 ? '' : 's'} waiting` : 'Activities'}
        title="Activities"
        onClick={() => setOpen(!open)}>
        <span aria-hidden className="size-5 shrink-0 bg-current"
          style={{ mask: 'url(/notifications/history.svg) center / contain no-repeat' }} />
        {pending > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-inverse">
            {pending}
          </span>
        )}
      </Button>
    </div>
  )
}

/** Keeps the closing content mounted until the width and slide transitions finish (the console's shell). */
function FeedPanelShell({ open, label, children }: { open: boolean; label: string; children: ReactNode }) {
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

function EventCard({ event }: { event: ActivityEvent }) {
  return (
    <div className="flex shrink-0 flex-col gap-3 border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="bg-alpha-8 px-1.5 py-0.5 text-[11px] leading-4 font-medium text-muted-foreground capitalize">{event.source}</span>
        <span className="truncate text-xs text-muted-foreground">{event.created}</span>
      </div>
      <div className="w-full truncate text-[13px] leading-[18px] font-medium">{event.kind}</div>
      {event.detail && (
        // Its own line, clipped with an ellipsis; the full text stays reachable through the tooltip.
        <p className="w-full truncate text-[13px] leading-[18px] text-muted-foreground" title={event.detail}>{event.detail}</p>
      )}
    </div>
  )
}

export function ActivitiesPanel({ projectId, branch, pending }: { projectId: string; branch: string; pending: number }) {
  const [open, setOpen] = useActivitiesOpen()
  const [limit, setLimit] = useState(ACTIVITY_PAGE_SIZE)
  // Another project starts from one page again.
  useEffect(() => { setLimit(ACTIVITY_PAGE_SIZE) }, [projectId])
  const { data, error } = usePoll(
    async () => ({ projectId, limit, events: mapEvents(await api.events(projectId, limit)) }),
    [projectId, limit],
    { intervalMs: 10_000, enabled: open },
  )
  // Tagged loads, so the previous project's cards never show under this one (lib/activity.ts).
  const { events, loadingMore, maybeMore } = panelState(data, projectId, limit, Boolean(error))

  return (
    <FeedPanelShell open={open} label="Activities">
      <div className="flex items-center justify-between p-3">
        <span className="text-base leading-7 font-medium">Activities</span>
        <button type="button" aria-label="Close activities" onClick={() => setOpen(false)}
          className="group flex size-9 items-center justify-center text-muted-foreground hover:text-foreground">
          <span className="flex size-8 items-center justify-center group-hover:bg-alpha-4"><X className="size-5" /></span>
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-3">
        {pending > 0 && (
          <Link to={`/p/${projectId}/${encodeURIComponent(branch)}/approvals`}
            className="flex shrink-0 flex-col gap-1 border border-border bg-card p-3 transition-colors hover:bg-alpha-4">
            <span className="self-start bg-warning px-1.5 py-0.5 text-[11px] leading-4 font-medium text-inverse">Needs Review</span>
            <span className="text-[13px] leading-[18px] font-medium">{pending} approval{pending === 1 ? '' : 's'} waiting</span>
            <span className="text-[13px] leading-[18px] text-muted-foreground">Open Approvals to allow or deny</span>
          </Link>
        )}
        {!events ? (
          error ? (
            <p className="text-sm text-muted-foreground">The daemon couldn&apos;t return the activity timeline.</p>
          ) : (
            <>
              <Skeleton className="h-20 shrink-0" />
              <Skeleton className="h-20 shrink-0" />
              <Skeleton className="h-20 shrink-0" />
            </>
          )
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity yet. Audit logs will appear here.</p>
        ) : (
          <>
            {/* Cards from an earlier poll stay; a failed refresh says so rather than passing them off as current. */}
            {error && <p className="text-xs text-destructive">Couldn&apos;t refresh the timeline. Showing the last one loaded.</p>}
            {events.map((event) => <EventCard key={event.id} event={event} />)}
            {maybeMore && (
              <Button variant="secondary" size="sm" className="shrink-0" disabled={loadingMore}
                onClick={() => setLimit((prev) => prev + ACTIVITY_PAGE_SIZE)}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            )}
          </>
        )}
      </div>
    </FeedPanelShell>
  )
}
