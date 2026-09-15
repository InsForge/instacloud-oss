import { describe, expect, it } from 'vitest'
import { badgeText, feedPanelFrom, pendingCount, reviewsFor, timeLabel } from './notifications'

const row = (id: string, status: string, requested_at: string, action = 'service.remove') => ({ id, action, status, requested_at })

describe('feedPanelFrom', () => {
  it('reads the shared panel, including the older boolean Activities value', () => {
    expect(feedPanelFrom('notifications')).toBe('notifications')
    expect(feedPanelFrom('activities')).toBe('activities')
    expect(feedPanelFrom('1')).toBe('activities')
    expect(feedPanelFrom(null)).toBeNull()
    expect(feedPanelFrom('something else')).toBeNull()
  })
})

describe('reviewsFor', () => {
  const load = {
    projectId: 'A',
    approvals: [
      row('old', 'granted', '2026-09-14T20:00:00.000Z'),
      row('new', 'pending', '2026-09-14T21:00:00.000Z', 'project.delete'),
      row('used', 'consumed', '2026-09-14T20:30:00.000Z'),
      row('no', 'denied', '2026-09-14T20:15:00.000Z'),
    ],
  }

  it("never shows another project's approvals: the poll hook keeps them across a switch", () => {
    expect(reviewsFor(load, 'B')).toEqual([])
    expect(reviewsFor(undefined, 'A')).toEqual([])
  })

  it('maps the daemon statuses, newest first', () => {
    expect(reviewsFor(load, 'A').map((r) => `${r.id}:${r.status}`)).toEqual(['new:needs-review', 'used:approved', 'no:denied', 'old:approved'])
    expect(reviewsFor(load, 'A')[0]).toEqual({ id: 'new', action: 'project.delete', createdAt: '2026-09-14T21:00:00.000Z', status: 'needs-review' })
  })

  it('skips a status it does not know, including an Object prototype name', () => {
    const odd = { projectId: 'A', approvals: [row('x', 'expired', '2026-09-14T21:00:00.000Z'), row('y', 'constructor', '2026-09-14T21:00:00.000Z')] }
    expect(reviewsFor(odd, 'A')).toEqual([])
  })

  it('shows a decision made here at once, over an approval the daemon still reports pending', () => {
    const reviews = reviewsFor(load, 'A', { projectId: 'A', byId: { new: 'denied' } })
    expect(reviews[0]!.status).toBe('denied')
    expect(pendingCount(reviews)).toBe(0)
  })

  it("lets the daemon's answer win over a local decision, and ignores decisions made for another project", () => {
    expect(reviewsFor(load, 'A', { projectId: 'A', byId: { old: 'denied' } }).find((r) => r.id === 'old')!.status).toBe('approved')
    expect(reviewsFor(load, 'A', { projectId: 'B', byId: { new: 'approved' } })[0]!.status).toBe('needs-review')
  })

  it('keeps the later-listed of two approvals at the same instant first', () => {
    const tie = { projectId: 'A', approvals: [row('first', 'pending', '2026-09-14T21:00:00.000Z'), row('second', 'pending', '2026-09-14T21:00:00.000Z')] }
    expect(reviewsFor(tie, 'A').map((r) => r.id)).toEqual(['second', 'first'])
  })
})

describe('pendingCount', () => {
  it('counts only the cards that still need review', () => {
    expect(pendingCount([
      { id: 'a', action: 'x', createdAt: '', status: 'needs-review' },
      { id: 'b', action: 'x', createdAt: '', status: 'approved' },
      { id: 'c', action: 'x', createdAt: '', status: 'needs-review' },
    ])).toBe(2)
  })
})

describe('timeLabel', () => {
  const now = Date.parse('2026-09-14T21:00:00.000Z')
  it('reads like the console: just now, then minutes, hours and days', () => {
    expect(timeLabel('2026-09-14T20:59:30.000Z', now)).toBe('Just now')
    expect(timeLabel('2026-09-14T20:59:00.000Z', now)).toBe('1 min ago')
    expect(timeLabel('2026-09-14T20:01:00.000Z', now)).toBe('59 min ago')
    expect(timeLabel('2026-09-14T20:00:00.000Z', now)).toBe('1 hr ago')
    expect(timeLabel('2026-09-13T21:00:00.000Z', now)).toBe('1 day ago')
    expect(timeLabel('2026-09-11T21:00:00.000Z', now)).toBe('3 days ago')
  })

  it('reads a clock-skewed future time as just now, and an unreadable one as a dash', () => {
    expect(timeLabel('2026-09-14T21:05:00.000Z', now)).toBe('Just now')
    expect(timeLabel('not a date', now)).toBe('—')
  })
})

describe('badgeText', () => {
  it('caps at 99+', () => {
    expect(badgeText(3)).toBe('3')
    expect(badgeText(99)).toBe('99')
    expect(badgeText(100)).toBe('99+')
  })
})
