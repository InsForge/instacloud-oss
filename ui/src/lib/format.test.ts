import { describe, expect, it } from 'vitest'
import { formatDateTime } from './format'

describe('formatDateTime', () => {
  it("reads like the console's Branches table: date, 12-hour time, in UTC", () => {
    expect(formatDateTime('2026-09-14T21:19:00.000Z')).toMatch(/^Sep 14, 2026, 9:19\sPM UTC$/u)
  })

  it('is UTC whatever the viewer zone, so a late-evening time keeps its UTC date', () => {
    expect(formatDateTime('2026-09-15T02:05:00.000Z')).toMatch(/^Sep 15, 2026, 2:05\sAM UTC$/u)
  })

  it('shows a dash for a missing or unreadable time', () => {
    expect(formatDateTime(undefined)).toBe('—')
    expect(formatDateTime(null)).toBe('—')
    expect(formatDateTime('not a date')).toBe('—')
  })
})
