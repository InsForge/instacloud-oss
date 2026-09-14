// The console's metric ranges (insta-frontend components/metrics/metric-charts.tsx), as a pure module
// so the window every poll asks for can be tested against a controlled clock.
//
// Self-host divergence: the console fetches once per range and fixes a longer range's window when it
// is picked. The dashboard polls every 30 s, and a window fixed at the click would never take in a new
// sample, so the window is recomputed from the clock on EVERY poll, for every range.

import type { ZeroFillWindow } from './metrics'

export const RANGES = {
  '1h': { seconds: 3_600, step: '60s', stepSeconds: 60 },
  '6h': { seconds: 21_600, step: '5m', stepSeconds: 300 },
  '24h': { seconds: 86_400, step: '15m', stepSeconds: 900 },
  '3d': { seconds: 259_200, step: '1h', stepSeconds: 3_600 },
} as const

export type RangeKey = keyof typeof RANGES

/** What one poll sends every component it merges: the SAME span, or the lines would not be comparable. */
export interface MetricsWindow {
  from: number
  to: number
  step: string
}

export interface ActiveRange {
  range: RangeKey
  window: MetricsWindow
  /** The zero-fill grid over the same span, on the daemon's bucket starts (multiples of the step). */
  zeroWindow: ZeroFillWindow
}

/** The window `range` covers at `nowMs`, ending now. The request ends at the current second so the
 *  newest sample is included; the zero-fill grid ends on the last whole step, because the daemon
 *  labels every bucket by its start — so an idle line's points land exactly where a real line's do. */
export function activeRange(range: RangeKey, nowMs: number): ActiveRange {
  const { seconds, step, stepSeconds } = RANGES[range]
  const to = Math.floor(nowMs / 1000)
  const gridTo = Math.floor(to / stepSeconds) * stepSeconds
  return {
    range,
    window: { from: to - seconds, to, step },
    zeroWindow: { from: gridTo - seconds, to: gridTo, stepSeconds },
  }
}
