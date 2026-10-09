// The console's topbar Activities control and its side panel (insta-frontend activities-panel.tsx): an icon cell
// that toggles the shared 320px column docked to the right of the content (ProjectFeedPanel.tsx), listing the
// project's events as cards, newest first. The events are fetched only while the panel is open. Approvals waiting
// on a decision live in the Notifications bell beside it (NotificationsPanel.tsx), as on the console.

import { useEffect, useState } from 'react'
import { Button, cn, Skeleton } from '@insforge/ui'
import { X } from 'lucide-react'
import { api } from '../../api'
import { usePoll } from '../../hooks'
import { ACTIVITY_PAGE_SIZE, mapEvents, panelState, type ActivityEvent } from '../../lib/activity'
import { FeedPanelShell, useProjectFeedPanel } from './ProjectFeedPanel'

/** Icon-only header cell, matching the account control beside it. */
export function ActivitiesButton() {
  const [panel, setPanel] = useProjectFeedPanel()
  const open = panel === 'activities'
  return (
    <div className="flex h-full shrink-0 items-center justify-center border-l border-border p-2">
      <Button variant="ghost" size="icon"
        className={cn('size-8 p-1.5 text-muted-foreground hover:text-foreground', open && 'bg-alpha-8 text-foreground')}
        aria-pressed={open}
        aria-label="Activities"
        title="Activities"
        onClick={() => setPanel(open ? null : 'activities')}>
        <span aria-hidden className="size-5 shrink-0 bg-current"
          style={{ mask: 'url(/notifications/history.svg) center / contain no-repeat' }} />
      </Button>
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

export function ActivitiesPanel({ projectId }: { projectId: string }) {
  const [panel, setPanel] = useProjectFeedPanel()
  const open = panel === 'activities'
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
        <button type="button" aria-label="Close activities" onClick={() => setPanel(null)}
          className="group flex size-9 items-center justify-center text-muted-foreground hover:text-foreground">
          <span className="flex size-8 items-center justify-center group-hover:bg-alpha-4"><X className="size-5" /></span>
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-3">
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
