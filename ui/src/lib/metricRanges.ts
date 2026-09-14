// The console's metric time ranges (insta-frontend lib/time-range.ts), as a pure module so the window every
// poll asks for can be tested against a controlled clock.
//
// Self-host divergences:
//   - the presets stop at 3 day: the daemon keeps three days of history, so the console's 7 day and 30 day
//     would chart mostly nothing, and a custom range is held to the same three days;
//   - the finest step is 30 s, the daemon's sampling interval (the console's 15 s steps would chart gaps);
//   - the console fetches once per preset and fixes its window at the click. The dashboard polls every 30 s,
//     and a window fixed at the click would never take in a new sample, so a preset's window is recomputed
//     from the clock on EVERY poll. A custom range names two instants and stays pinned.

import type { ZeroFillWindow } from './metrics'

export const RANGES = {
  '5m': { label: '5 min', seconds: 300, step: '30s', stepSeconds: 30 },
  '15m': { label: '15 min', seconds: 900, step: '30s', stepSeconds: 30 },
  '30m': { label: '30 min', seconds: 1_800, step: '30s', stepSeconds: 30 },
  '1h': { label: '1 hour', seconds: 3_600, step: '60s', stepSeconds: 60 },
  '3h': { label: '3 hour', seconds: 10_800, step: '2m', stepSeconds: 120 },
  '6h': { label: '6 hour', seconds: 21_600, step: '5m', stepSeconds: 300 },
  '1d': { label: '1 day', seconds: 86_400, step: '15m', stepSeconds: 900 },
  '3d': { label: '3 day', seconds: 259_200, step: '1h', stepSeconds: 3_600 },
} as const

export type RangeKey = keyof typeof RANGES

/** The picker's quick ranges, in the console's reading order. */
export const PRESET_KEYS = Object.keys(RANGES) as RangeKey[]

/** How far back a custom range may reach: the daemon's retention. */
export const MAX_LOOKBACK_DAYS = 3

/** What one poll sends every component it merges: the SAME span, or the lines would not be comparable. */
export interface MetricsWindow {
  from: number
  to: number
  step: string
}

export interface ActiveRange {
  /** A preset key, or "custom" for a hand-entered from/to. */
  range: RangeKey | 'custom'
  window: MetricsWindow
  /** The zero-fill grid over the same span, on the daemon's bucket starts (multiples of the step). */
  zeroWindow: ZeroFillWindow
}

/** The window preset `range` covers at `nowMs`, ending now. The request ends at the current second so the
 *  newest sample is included; the zero-fill grid ends on the last whole step, because the daemon labels
 *  every bucket by its start, so an idle line's points land exactly where a real line's do. */
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

/** The same range, recomputed against the clock: a preset rolls forward, a custom range stays where it was
 *  put (same object, so a caller can tell nothing changed). */
export function tickedRange(active: ActiveRange, nowMs: number): ActiveRange {
  return active.range === 'custom' ? active : activeRange(active.range, nowMs)
}

/** Step ladder for a hand-entered span, finest first, never finer than the daemon samples. */
const STEP_LADDER = [
  { step: '30s', stepSeconds: 30 },
  { step: '60s', stepSeconds: 60 },
  { step: '2m', stepSeconds: 120 },
  { step: '5m', stepSeconds: 300 },
  { step: '15m', stepSeconds: 900 },
  { step: '30m', stepSeconds: 1_800 },
  { step: '1h', stepSeconds: 3_600 },
] as const

/** Points per chart, as on the console: enough to read a spike, few enough to read at all. */
const MAX_POINTS = 90

/** The coarsest step that keeps `seconds` within the point budget, or null for a span too long to chart. */
export function stepForSpan(seconds: number): { step: string; stepSeconds: number } | null {
  return STEP_LADDER.find((entry) => seconds / entry.stepSeconds <= MAX_POINTS) ?? null
}

/** A hand-entered window: pinned, with a step from the ladder, or null when it spans too long to chart or
 *  reaches past the daemon's retention. The grid snaps both ends to the daemon's bucket starts. */
export function customRange(from: number, to: number, nowMs: number): ActiveRange | null {
  if (to <= from) return null
  if (from < Math.floor(nowMs / 1000) - MAX_LOOKBACK_DAYS * 86_400) return null
  const fit = stepForSpan(to - from)
  if (!fit) return null
  return {
    range: 'custom',
    window: { from, to, step: fit.step },
    zeroWindow: {
      from: Math.floor(from / fit.stepSeconds) * fit.stepSeconds,
      to: Math.floor(to / fit.stepSeconds) * fit.stepSeconds,
      stepSeconds: fit.stepSeconds,
    },
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Unix seconds → "YYYY-MM-DD HH:MM" in the viewer's zone, the format the inputs round-trip. */
export function formatLocalInput(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Unix seconds → "MM-DD HH:MM", for the trigger's own custom-range label. */
export function formatLocalShort(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The trigger's label: a preset's name, or a custom range's two ends. */
export function rangeLabel(active: ActiveRange): string {
  if (active.range !== 'custom') return RANGES[active.range].label
  return `${formatLocalShort(active.window.from)} → ${formatLocalShort(active.window.to)}`
}

/**
 * "YYYY-MM-DD HH:MM" → unix seconds, read in the viewer's zone so what the field shows is the clock the
 * charts are labelled on. A full ISO instant with its own offset also parses. Returns null when nothing
 * does, including a date that rolls over (2026-13-45).
 */
export function parseLocalInput(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    const iso = new Date(trimmed)
    return Number.isNaN(iso.getTime()) ? null : Math.floor(iso.getTime() / 1000)
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(trimmed)
  if (!m) return null
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const [hour, minute] = [Number(m[4] ?? 0), Number(m[5] ?? 0)]
  const d = new Date(year, month - 1, day, hour, minute)
  const roundTrips = d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day
    && d.getHours() === hour && d.getMinutes() === minute
  return roundTrips ? Math.floor(d.getTime() / 1000) : null
}

function timeOfDay(unixSeconds: number): { h: number; m: number } {
  const d = new Date(unixSeconds * 1000)
  return { h: d.getHours(), m: d.getMinutes() }
}

/** A calendar-picked day, keeping the time of day already in the field (00:00 for an unreadable one). */
export function withPickedDay(text: string, day: Date): string {
  const existing = parseLocalInput(text)
  const clock = existing === null ? { h: 0, m: 0 } : timeOfDay(existing)
  const merged = new Date(day.getFullYear(), day.getMonth(), day.getDate(), clock.h, clock.m)
  return formatLocalInput(Math.floor(merged.getTime() / 1000))
}

/** A picked "HH:MM", keeping the date already in the field (today for an unreadable one). */
export function withPickedTime(text: string, hhmm: string, nowMs: number): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return text
  const existing = parseLocalInput(text)
  const base = existing === null ? new Date(nowMs) : new Date(existing * 1000)
  const merged = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Number(m[1]), Number(m[2]))
  return formatLocalInput(Math.floor(merged.getTime() / 1000))
}

/** The "HH:MM" half of a field's text, or "" for an unreadable one. */
export function timeOfDayText(text: string): string {
  const secs = parseLocalInput(text)
  if (secs === null) return ''
  const { h, m } = timeOfDay(secs)
  return `${pad(h)}:${pad(m)}`
}

/** "00".."23" and "00".."59": hours and minutes are picked apart, so every minute is reachable. */
export const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => pad(h))
export const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, m) => pad(m))

/** The viewer's zone at an instant: "PDT" where there is an abbreviation, the offset ("GMT+5:30") where
 *  there is not. `timeZone` exists for tests. */
export function localZoneAbbr(at: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZoneName: 'short', ...(timeZone ? { timeZone } : {}) })
    .formatToParts(at)
    .find((part) => part.type === 'timeZoneName')?.value ?? ''
}
