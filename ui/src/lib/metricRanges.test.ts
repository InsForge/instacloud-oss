import { describe, expect, it } from 'vitest'
import {
  activeRange, customRange, formatLocalInput, gridPoints, localZoneAbbr, MAX_CUSTOM_POINTS, parseLocalInput, pickerFields,
  PRESET_KEYS, RANGES, rangeLabel, stepForRange, tickedRange, withPickedDay, withPickedTime, type RangeKey,
} from './metricRanges'

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

describe('the presets', () => {
  it("carry the console's labels, stop at the daemon's seven-day retention, and step no finer than its 30 s samples", () => {
    expect(PRESET_KEYS.map((key) => RANGES[key].label)).toEqual(['5 min', '15 min', '30 min', '1 hour', '3 hour', '6 hour', '1 day', '3 day', '7 day'])
    for (const key of PRESET_KEYS) {
      expect(RANGES[key].seconds).toBeLessThanOrEqual(7 * 86_400)
      expect(RANGES[key].stepSeconds).toBeGreaterThanOrEqual(30)
      expect(RANGES[key].seconds % RANGES[key].stepSeconds).toBe(0)
    }
  })
})

describe('tickedRange', () => {
  it('rolls a preset forward and leaves a custom range pinned', () => {
    const preset = activeRange('1h', T0)
    expect(tickedRange(preset, T0 + 60_000).window.to).toBe(preset.window.to + 60)
    const now = Math.floor(T0 / 1000)
    const pinned = customRange(now - 7_200, now - 3_600, T0)!
    expect(tickedRange(pinned, T0 + 60_000)).toBe(pinned)
  })
})

describe('pickerFields', () => {
  it("opens a preset on the window the charts show now, not the one from when it was picked", () => {
    const preset = activeRange('1h', T0)
    const later = T0 + 45 * 60_000
    const fields = pickerFields(preset, later)
    expect(fields.until).toBe(formatLocalInput(activeRange('1h', later).window.to))
    expect(fields.from).toBe(formatLocalInput(activeRange('1h', later).window.from))
    expect(fields.until).not.toBe(formatLocalInput(preset.window.to))
  })

  it('opens a custom range on its pinned ends', () => {
    const now = Math.floor(T0 / 1000)
    const pinned = customRange(now - 7_200, now - 3_600, T0)!
    expect(pickerFields(pinned, T0 + 45 * 60_000)).toEqual({
      from: formatLocalInput(pinned.window.from), until: formatLocalInput(pinned.window.to),
    })
  })
})

describe('customRange', () => {
  const now = Math.floor(T0 / 1000)

  it('takes the finest step within the point budget and snaps the grid to bucket starts', () => {
    const r = customRange(now - 7_193, now - 13, T0)! // 7,180 s: 60 s would be 120 points, 2 m is 60
    expect(r.range).toBe('custom')
    expect(r.window.step).toBe('2m')
    expect(r.zeroWindow.from % 120).toBe(0)
    expect(r.zeroWindow.to % 120).toBe(0)
    expect(r.zeroWindow.from).toBeLessThanOrEqual(r.window.from)
    expect(r.zeroWindow.to).toBeLessThanOrEqual(r.window.to)
  })

  it('refuses a range reaching past the seven days the daemon keeps, and an empty or reversed one', () => {
    expect(customRange(now - 7 * 86_400 - 60, now, T0)).toBeNull()
    expect(customRange(now, now, T0)).toBeNull()
    expect(customRange(now, now - 60, T0)).toBeNull()
  })

  it('never steps finer than the daemon samples', () => {
    expect(stepForRange(now - 60, now)!.step).toBe('30s')
  })

  // The grid draws both ends, so a span of exactly 90 steps is 91 points (regression: 45 min at 30 s).
  it.each([
    ['45 min', 2_700, '60s'],
    ['90 min', 5_400, '2m'],
    ['3 hour', 10_800, '5m'],
  ])('keeps an aligned %s range within the point budget at the ladder boundary', (_, span, step) => {
    const to = Math.floor(now / 3_600) * 3_600
    const r = customRange(to - span, to, T0)!
    expect(r.window.step).toBe(step)
    const { from, to: gridTo, stepSeconds } = r.zeroWindow
    expect(gridPoints(from, gridTo, stepSeconds)).toBeLessThanOrEqual(MAX_CUSTOM_POINTS)
  })

  it('counts the points the zero-fill grid actually draws, both ends included', () => {
    expect(gridPoints(0, 2_700, 30)).toBe(91)
    // Off-boundary ends snap separately, so a span just over 90 steps can reach 92 points.
    expect(gridPoints(29, 2_730, 30)).toBe(92)
  })

  it('never charts more points than the budget, for any range within retention', () => {
    for (let span = 60; span <= 7 * 86_400; span += 97) {
      for (const offset of [0, 13, 29]) {
        const to = now - 61 - offset
        const r = customRange(to - span, to, T0)
        if (!r) continue
        const { from, to: gridTo, stepSeconds } = r.zeroWindow
        let points = 0
        for (let t = from; t <= gridTo; t += stepSeconds) points++
        expect(points, `${span}s +${offset}`).toBeLessThanOrEqual(MAX_CUSTOM_POINTS)
      }
    }
  })

  it('labels the trigger with its two ends', () => {
    expect(rangeLabel(customRange(now - 3_600, now, T0)!)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2} → \d{2}-\d{2} \d{2}:\d{2}$/)
    expect(rangeLabel(activeRange('1h', T0))).toBe('1 hour')
  })
})

describe('the From / until fields', () => {
  it('round-trip a local "YYYY-MM-DD HH:MM"', () => {
    expect(formatLocalInput(parseLocalInput('2026-09-14 13:05')!)).toBe('2026-09-14 13:05')
  })

  it('reject a date that rolls over, and anything else unreadable', () => {
    expect(parseLocalInput('2026-13-45 99:99')).toBeNull()
    expect(parseLocalInput('soon')).toBeNull()
    expect(parseLocalInput('')).toBeNull()
  })

  it('accept a full ISO instant with its own offset', () => {
    expect(parseLocalInput('2026-09-14T21:19:00Z')).toBe(Date.UTC(2026, 8, 14, 21, 19) / 1000)
  })

  it('keep the time when a day is picked, and the date when a time is picked', () => {
    expect(withPickedDay('2026-09-14 14:30', new Date(2026, 8, 12))).toBe('2026-09-12 14:30')
    expect(withPickedTime('2026-09-14 14:30', '09:05', T0)).toBe('2026-09-14 09:05')
    expect(withPickedTime('2026-09-14 14:30', 'nope', T0)).toBe('2026-09-14 14:30')
  })

  it("name the viewer's zone the way the trigger shows it", () => {
    expect(localZoneAbbr(new Date(Date.UTC(2026, 8, 14)), 'America/Los_Angeles')).toBe('PDT')
  })
})
