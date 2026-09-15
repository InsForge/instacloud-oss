// The console's review notifications (insta-frontend components/project/use-notification-review-preview.tsx,
// notifications-panel.tsx, review-notification-stack.tsx), pure so the root vitest covers them.
//
// Self-host divergence: the console's cards are local previews ("Decisions never call the approval API"). Here
// they are the daemon's approvals, which it enforces, and Approve / Deny decide them. An approval records neither
// who asked nor who decided, so a card has no "by …" line.

/** Activities and Notifications take turns in one side panel. */
export type FeedPanel = 'activities' | 'notifications' | null

/** The panel saved under the console's key, which also reads the older boolean Activities "1" as open. */
export function feedPanelFrom(saved: string | null): FeedPanel {
  if (saved === 'notifications') return 'notifications'
  return saved === 'activities' || saved === '1' ? 'activities' : null
}

export type ReviewStatus = 'needs-review' | 'approved' | 'denied'
export type ReviewDecision = Exclude<ReviewStatus, 'needs-review'>
export type ReviewNotification = { id: string; action: string; createdAt: string; status: ReviewStatus }

type ApprovalRow = { id: string; action: string; status: string; requested_at: string }

/** The approvals poll, tagged with the project it read: the poll hook keeps the previous project's answer across
 *  a switch, so an untagged list would show one project's approvals under another. */
export type ApprovalsLoad = { projectId: string; approvals: readonly ApprovalRow[] }

/** Decisions made here that the next poll has not reflected yet, for one project. */
export type Decisions = { projectId: string; byId: Readonly<Record<string, ReviewDecision>> }

/** A consumed approval was granted and then used, so it reads as approved. */
const STATUS = new Map<string, ReviewStatus>([
  ['pending', 'needs-review'], ['granted', 'approved'], ['consumed', 'approved'], ['denied', 'denied'],
])

/** The cards for `projectId`, newest first: none until a load for THIS project has answered. A decision made here
 *  shows at once, but only over an approval the daemon still reports as pending, so the daemon's answer wins as
 *  soon as it arrives. */
export function reviewsFor(load: ApprovalsLoad | undefined, projectId: string, decisions?: Decisions): ReviewNotification[] {
  if (!load || load.projectId !== projectId) return []
  const local = decisions?.projectId === projectId ? decisions.byId : {}
  const at = (iso: string) => {
    const t = Date.parse(iso)
    return Number.isNaN(t) ? 0 : t
  }
  return load.approvals
    .map((approval, index) => ({ approval, index, status: STATUS.get(approval.status) }))
    .filter((row): row is { approval: ApprovalRow; index: number; status: ReviewStatus } => row.status !== undefined)
    .sort((a, b) => at(b.approval.requested_at) - at(a.approval.requested_at) || b.index - a.index)
    .map(({ approval, status }) => ({
      id: approval.id,
      action: approval.action,
      createdAt: approval.requested_at,
      status: status === 'needs-review' ? (Object.hasOwn(local, approval.id) ? local[approval.id]! : status) : status,
    }))
}

export function pendingCount(reviews: readonly ReviewNotification[]): number {
  return reviews.filter((review) => review.status === 'needs-review').length
}

/** "Just now", "3 min ago", "2 hr ago", "4 days ago"; "—" for an unreadable time. */
export function timeLabel(iso: string, nowMs: number): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const minutes = Math.floor(Math.max(0, nowMs - t) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** The bell's badge, capped as on the console. */
export function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count)
}

/** How many pending cards the stack over the content shows at once. */
export const MAX_STACKED_REVIEWS = 3
