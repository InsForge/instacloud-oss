import { describe, expect, it } from 'vitest'
import { activeRange, RANGES, type RangeKey } from './metricRanges'

const T0 = Date.UTC(2026, 8, 14, 19, 0, 7) // a poll that lands mid-minute

describe('activeRange — the window a poll asks for (regression: longer ranges froze when picked)', () => {
  it.each(Object.keys(RANGES) as RangeKey[])('%s rolls forward with the clock on every poll', (range) => {
    const first = activeRange(range, T0)
    const later = activeRange(range, T0 + 30_000) // the next 30 s poll
    expect(later.window.to - first.window.to).toBe(30)
    expect(later.window.from - first.window.from).toBe(30)
    expect(later.window.step).toBe(first.window.step)
  })

  it.each(Object.keys(RANGES) as RangeKey[])('%s ends at the current second and spans exactly the range', (range) => {
    const { window } = activeRange(range, T0)
    expect(window.to).toBe(Math.floor(T0 / 1000))
    expect(window.to - window.from).toBe(RANGES[range].seconds)
    expect(window.step).toBe(RANGES[range].step)
  })

  it.each(Object.keys(RANGES) as RangeKey[])('%s zero-fills on the daemon bucket starts, over the same span', (range) => {
    const { zeroWindow } = activeRange(range, T0 + 17 * 60_000)
    const step = RANGES[range].stepSeconds
    expect(zeroWindow.stepSeconds).toBe(step)
    expect(zeroWindow.to % step).toBe(0)
    expect(zeroWindow.from % step).toBe(0)
    expect(zeroWindow.to - zeroWindow.from).toBe(RANGES[range].seconds)
    expect(zeroWindow.to).toBeLessThanOrEqual(activeRange(range, T0 + 17 * 60_000).window.to)
  })

  it('a longer range picked earlier still takes in a sample written after it was picked', () => {
    const pickedAt = activeRange('6h', T0)
    const sampleAt = Math.floor(T0 / 1000) + 45
    expect(sampleAt).toBeGreaterThan(pickedAt.window.to) // outside the window fixed at the click…
    const polled = activeRange('6h', T0 + 60_000)
    expect(sampleAt).toBeLessThanOrEqual(polled.window.to) // …inside the one the next poll asks for
    expect(sampleAt).toBeGreaterThanOrEqual(polled.window.from)
  })
})
