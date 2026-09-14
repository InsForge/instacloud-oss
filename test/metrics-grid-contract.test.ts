// The daemon's bucket lattice and the dashboard's zero-fill grid are one contract that two files own:
// src/metrics-history.ts labels a bucket by `floor(t / step) * step`, and ui/src/lib/metricRanges.ts
// draws idle lines on a grid it computes independently. If they disagree, tooltips on a card mixing a
// reporting service with an idle one find only one of them. Each side's own tests pass whatever the
// other does, so this runs BOTH and checks every real point lands on a grid point.

import { describe, expect, it } from 'vitest'
import { MetricsHistory, metricsWindow, parseStep } from '../src/metrics-history'
import { activeRange, customRange, RANGES, type RangeKey } from '../ui/src/lib/metricRanges'

const TARGET = { container: 'io-demo-main-app-web', group: 'web' }
const BASE = Date.UTC(2026, 8, 14, 19, 0, 0)

describe('the daemon buckets and the dashboard zero-fill grid coincide', () => {
  it.each(Object.keys(RANGES) as RangeKey[])('%s, at clock times that do not sit on a step boundary', (range) => {
    for (const offsetSec of [0, 7, 59, 61, 137, 299, 301, 899, 1_801, 3_599]) {
      const { window, zeroWindow } = activeRange(range, BASE + offsetSec * 1000)
      // The daemon answers the window the dashboard sends, parsed the way the route parses it.
      const served = metricsWindow({ from: String(window.from), to: String(window.to), step: window.step }, window.to)
      if (!('step' in served)) throw new Error(`the daemon refused ${JSON.stringify(window)}`)
      expect(served.step).toBe(parseStep(window.step))

      const h = new MetricsHistory()
      for (let t = window.from; t <= window.to; t += 30) h.record(t, [{ name: TARGET.container, cpuCores: 0.1, memBytes: 1, rxBytes: 0, txBytes: 0 }])
      const points = h.query([TARGET], served.from, served.to, served.step).find((s) => s.name === 'cpu_cores')!.points

      const grid = new Set<number>()
      for (let t = zeroWindow.from; t <= zeroWindow.to; t += zeroWindow.stepSeconds) grid.add(t)
      const offGrid = points.map(([t]) => t).filter((t) => !grid.has(t))
      expect(offGrid, `${range} at +${offsetSec}s`).toEqual([])
    }
  })

  it('a custom range, with ends that do not sit on a step boundary', () => {
    const base = Math.floor(BASE / 1000)
    for (const [fromOff, toOff] of [[7, 3_599], [61, 7_201], [1_801, 86_399], [13, 259_000]] as const) {
      const range = customRange(base + fromOff, base + toOff, (base + toOff + 60) * 1000)
      if (!range) throw new Error(`no custom range for +${fromOff}..+${toOff}`)
      const { window, zeroWindow } = range
      const served = metricsWindow({ from: String(window.from), to: String(window.to), step: window.step }, window.to)
      if (!('step' in served)) throw new Error(`the daemon refused ${JSON.stringify(window)}`)
      expect(served.step).toBe(parseStep(window.step))

      const h = new MetricsHistory()
      for (let t = window.from; t <= window.to; t += 30) h.record(t, [{ name: TARGET.container, cpuCores: 0.1, memBytes: 1, rxBytes: 0, txBytes: 0 }])
      const points = h.query([TARGET], served.from, served.to, served.step).find((s) => s.name === 'cpu_cores')!.points

      const grid = new Set<number>()
      for (let t = zeroWindow.from; t <= zeroWindow.to; t += zeroWindow.stepSeconds) grid.add(t)
      const offGrid = points.map(([t]) => t).filter((t) => !grid.has(t))
      expect(offGrid, `custom +${fromOff}..+${toOff}`).toEqual([])
    }
  })
})
