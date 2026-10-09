import { describe, expect, it } from 'vitest'
import { beginDelete, endDelete, isDeleting, subscribeDeletes } from './deleteInFlight'

describe('the Delete Project in-flight lock', () => {
  it('refuses a second delete while one is in flight, even from a remounted dialog', () => {
    expect(beginDelete('p1')).toBe(true)
    // Back then Forward remounts the dialog; it asks the same lock and is refused.
    expect(beginDelete('p1')).toBe(false)
    expect(isDeleting('p1')).toBe(true)
    endDelete('p1')
  })

  it('allows the next delete once the first has settled', () => {
    expect(beginDelete('p2')).toBe(true)
    endDelete('p2')
    expect(isDeleting('p2')).toBe(false)
    expect(beginDelete('p2')).toBe(true)
    endDelete('p2')
  })

  it("keeps one project's delete from blocking another's", () => {
    expect(beginDelete('p3')).toBe(true)
    expect(beginDelete('p4')).toBe(true)
    endDelete('p3')
    endDelete('p4')
  })

  it('tells subscribers when a delete starts and ends, so a dialog mounted mid-request clears', () => {
    const seen: boolean[] = []
    const unsubscribe = subscribeDeletes(() => seen.push(isDeleting('p5')))
    beginDelete('p5')
    endDelete('p5')
    unsubscribe()
    beginDelete('p5')
    endDelete('p5')
    expect(seen).toEqual([true, false])
  })
})
