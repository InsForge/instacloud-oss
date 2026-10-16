// The console's Notifications control, its side panel and the pending-review stack (insta-frontend
// notifications-panel.tsx, review-notification-card.tsx, review-notification-stack.tsx): a bell with a count of
// approvals waiting, a 320px panel that takes turns with Activities (All notifications / Needs review), and up to
// three pending cards stacked over the top right of the content until they are decided or dismissed. Dismissing
// the stack only hides it; the approvals stay pending in the bell.
//
// Self-host divergences: the cards are the daemon's approvals and Approve / Deny decide them, where the console's
// are local previews; a card has no "by …" line, and a decided one shows its badge alone rather than "Approved by
// You", because an approval records neither who asked nor who decided (lib/notifications.ts).

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Button, cn } from '@insforge/ui'
import { X } from 'lucide-react'
import { formatLocalDateTime } from '../../lib/activity'
import { badgeText, MAX_STACKED_REVIEWS, timeLabel, type ReviewDecision, type ReviewNotification } from '../../lib/notifications'
import { FeedPanelShell, useProjectFeedPanel } from './ProjectFeedPanel'

/** The current time, refreshed every half minute, so "Just now" becomes "1 min ago" without a reload. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

export function NotificationsButton({ count }: { count: number }) {
  const [panel, setPanel] = useProjectFeedPanel()
  const open = panel === 'notifications'
  return (
    <div className="relative flex h-full shrink-0 items-center justify-center border-l border-border p-2">
      <Button variant="ghost" size="icon"
        className={cn('size-8 p-1.5 text-muted-foreground hover:text-foreground', open && 'bg-alpha-8 text-foreground')}
        aria-pressed={open}
        aria-label={count ? `Notifications, ${count} needs review` : 'Notifications'}
        title="Notifications"
        data-notifications-trigger
        onClick={() => setPanel(open ? null : 'notifications')}>
        <span aria-hidden className="size-5 shrink-0 bg-current" style={{ mask: 'url(/notifications/bell.svg) center / contain no-repeat' }} />
      </Button>
      {count > 0 && (
        <span aria-hidden="true"
          className="pointer-events-none absolute top-2 left-[23px] z-40 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-xs leading-4 font-medium text-white">
          {badgeText(count)}
        </span>
      )}
    </div>
  )
}

export function ReviewNotificationCard({ review, nowMs, onDecide, disabled = false }: {
  review: ReviewNotification
  nowMs: number
  onDecide: (id: string, decision: ReviewDecision) => void
  disabled?: boolean
}) {
  const pending = review.status === 'needs-review'
  return (
    <article aria-label={review.action}
      className={cn('flex shrink-0 flex-col gap-3 border border-border p-3', pending ? 'review-notification-surface' : 'bg-card')}>
      <div className="flex items-center justify-between gap-2">
        <span className={cn(
          'px-2 py-0.5 text-xs leading-4 font-medium',
          pending ? 'bg-warning text-inverse' : review.status === 'approved' ? 'bg-success text-inverse' : 'bg-destructive text-white',
        )}>
          {pending ? 'Needs Review' : review.status === 'approved' ? 'Approved' : 'Denied'}
        </span>
        <time dateTime={review.createdAt} title={formatLocalDateTime(review.createdAt)} className="truncate text-xs leading-4 text-muted-foreground/75">
          {timeLabel(review.createdAt, nowMs)}
        </time>
      </div>
      <p className="truncate text-sm leading-6" title={review.action}>{review.action}</p>
      {pending && (
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" className="h-7 flex-1 border-alpha-8 bg-alpha-4" disabled={disabled}
            onClick={() => onDecide(review.id, 'denied')}>Deny</Button>
          <Button variant="primary" size="sm" className="h-7 flex-1" disabled={disabled}
            onClick={() => onDecide(review.id, 'approved')}>Approve</Button>
        </div>
      )}
    </article>
  )
}

export function NotificationsPanel({ reviews, error, onDecide }: {
  reviews: ReviewNotification[]
  /** The last decision the daemon refused, shown until the next one. */
  error: string | null
  onDecide: (id: string, decision: ReviewDecision) => void
}) {
  const [panel, setPanel] = useProjectFeedPanel()
  const [filter, setFilter] = useState<'all' | 'needs-review'>('all')
  const now = useNow()
  const shown = filter === 'all' ? reviews : reviews.filter((review) => review.status === 'needs-review')
  return (
    <FeedPanelShell open={panel === 'notifications'} label="Notifications">
      <div className="flex items-center justify-between p-3">
        <span className="text-base leading-7 font-medium">Notifications</span>
        <button type="button" aria-label="Close notifications" onClick={() => setPanel(null)}
          className="group flex size-9 items-center justify-center text-muted-foreground hover:text-foreground">
          <span className="flex size-8 items-center justify-center group-hover:bg-alpha-4"><X className="size-5" /></span>
        </button>
      </div>
      <div className="px-3 pb-3">
        <div role="group" aria-label="Filter notifications" className="grid grid-cols-2 gap-0.5 border border-border bg-card p-0.5">
          {([
            { value: 'all', label: 'All notifications' },
            { value: 'needs-review', label: 'Needs review' },
          ] as const).map(({ value, label }) => (
            <Button key={value} type="button" variant="ghost" size="sm" aria-pressed={filter === value} onClick={() => setFilter(value)}
              className={cn('h-8 rounded-none px-2 text-[13px]', filter === value ? 'bg-alpha-8 text-foreground' : 'text-muted-foreground')}>
              {label}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-3">
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        {shown.length > 0
          ? shown.map((review) => <ReviewNotificationCard key={review.id} review={review} nowMs={now} onDecide={onDecide} />)
          : <p role="status" className="text-sm text-muted-foreground">{filter === 'all' ? 'No notifications yet.' : 'No notifications need review.'}</p>}
      </div>
    </FeedPanelShell>
  )
}

/** Up to three pending cards over the top right of the content, newest in front. */
export function ReviewNotificationStack({ reviews, error, onDecide }: {
  reviews: ReviewNotification[]
  error: string | null
  onDecide: (id: string, decision: ReviewDecision) => void
}) {
  const [panel] = useProjectFeedPanel()
  const now = useNow()
  // Already newest first (lib/notifications.ts).
  const pending = reviews.filter((review) => review.status === 'needs-review')
  const signature = JSON.stringify(pending.map(({ id }) => id))
  const [presentation, setPresentation] = useState({ signature, dismissed: [] as string[] })
  const [exiting, setExiting] = useState<ReviewNotification | null>(null)
  const [promotedId, setPromotedId] = useState<string | null>(null)
  const stackRef = useRef<HTMLElement>(null)
  const cardsRef = useRef<HTMLDivElement>(null)
  const [dismissal, setDismissal] = useState<{ ids: string[]; x: number; y: number } | null>(null)
  const restoreFocus = useRef(false)

  // Dismissals last only while their approvals stay pending: a new approval, even with an unchanged count,
  // surfaces the stack again.
  if (presentation.signature !== signature) {
    setPresentation({ signature, dismissed: presentation.dismissed.filter((id) => pending.some((review) => review.id === id)) })
  }

  useEffect(() => {
    if (!exiting) return
    // Also completes with reduced motion, or when the animation is interrupted.
    const timeout = window.setTimeout(() => setExiting(null), 260)
    return () => window.clearTimeout(timeout)
  }, [exiting])

  useEffect(() => {
    if (exiting || !restoreFocus.current) return
    restoreFocus.current = false
    const target = stackRef.current?.querySelector<HTMLButtonElement>('article button')
      ?? document.querySelector<HTMLButtonElement>('[data-notifications-trigger]')
    target?.focus({ preventScroll: true })
  }, [exiting])

  useEffect(() => {
    if (!dismissal) return
    // The fallback also covers reduced motion and interrupted animations.
    const timeout = window.setTimeout(() => {
      setPresentation((previous) => ({ ...previous, dismissed: [...new Set([...previous.dismissed, ...dismissal.ids])] }))
      setDismissal(null)
    }, 300)
    return () => window.clearTimeout(timeout)
  }, [dismissal])

  // The outgoing card keeps its slot until it has left; only then does the next queued approval join the stack.
  const visible = pending.filter(({ id }) => !presentation.dismissed.includes(id)).slice(0, MAX_STACKED_REVIEWS - (exiting ? 1 : 0))
  const first = visible[0]
  if (!first && !exiting) return null

  function decide(id: string, decision: ReviewDecision) {
    if (exiting || dismissal || !first) return
    restoreFocus.current = stackRef.current?.contains(document.activeElement) ?? false
    setPromotedId(visible[1]?.id ?? null)
    setExiting(first)
    onDecide(id, decision)
  }

  function dismiss() {
    if (dismissal) return
    const trigger = document.querySelector<HTMLButtonElement>('[data-notifications-trigger]')
    const cards = cardsRef.current?.getBoundingClientRect()
    const target = trigger?.getBoundingClientRect()
    setDismissal({
      ids: pending.map(({ id }) => id),
      x: cards && target ? target.left + target.width / 2 - (cards.left + cards.width / 2) : 100,
      y: cards && target ? target.top + target.height / 2 - (cards.top + cards.height / 2) : -100,
    })
    setExiting(null)
    setPromotedId(null)
    trigger?.focus({ preventScroll: true })
  }

  return (
    <section ref={stackRef} aria-label="Pending review notifications"
      aria-hidden={panel === 'notifications' || undefined} inert={panel === 'notifications'}
      data-panel={panel ?? 'closed'}
      className="review-notification-position pointer-events-none absolute top-0 left-0 z-30 overflow-x-clip">
      <div className="ml-auto w-[344px] max-w-full pt-3 pr-3 pb-6 pl-3">
        <div ref={cardsRef} aria-hidden={!!dismissal || undefined} inert={!!dismissal}
          className={cn('group/review-stack pointer-events-auto relative grid w-full items-start pb-3', dismissal && 'review-notification-dismiss')}
          style={dismissal ? ({ '--review-dismiss-x': `${dismissal.x}px`, '--review-dismiss-y': `${dismissal.y}px` } as CSSProperties) : undefined}>
          <Button variant="secondary" size="icon" aria-label="Dismiss review notifications"
            className="pointer-events-none absolute -top-2.5 -left-2.5 z-20 size-5 border-border bg-card p-0 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/review-stack:pointer-events-auto group-hover/review-stack:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 motion-reduce:transition-none"
            onClick={dismiss}>
            <span aria-hidden className="size-5 bg-current" style={{ mask: 'url(/notifications/close.svg) center / contain no-repeat' }} />
          </Button>
          {visible.length > 2 && (
            <div aria-hidden className="review-notification-surface review-notification-layer-third pointer-events-none absolute inset-x-3 top-3 bottom-0 border border-border shadow-md" />
          )}
          {visible.length > 1 && (
            <div aria-hidden className="review-notification-surface review-notification-layer-second pointer-events-none absolute inset-x-1.5 top-1.5 bottom-1.5 border border-border shadow-md" />
          )}
          {first && (
            <div key={first.id}
              className={cn('pointer-events-auto relative col-start-1 row-start-1 shadow-md', first.id === promotedId ? 'review-notification-promote' : 'review-notification-enter')}>
              <ReviewNotificationCard review={first} nowMs={now} onDecide={decide} disabled={!!exiting || !!dismissal} />
            </div>
          )}
          {exiting && (
            <div aria-hidden inert className="review-notification-exit relative z-10 col-start-1 row-start-1 shadow-md" onAnimationEnd={() => setExiting(null)}>
              <ReviewNotificationCard review={exiting} nowMs={now} onDecide={decide} disabled />
            </div>
          )}
        </div>
        {error && <p role="alert" className="pointer-events-auto border border-border bg-card p-2 text-xs text-destructive">{error}</p>}
      </div>
    </section>
  )
}
