// The rows behind a Runtime Logs tab (insta-frontend lib/api/mappers/logs.ts `mapLogs` and `toSeverity`,
// lib/hooks/use-log-filters.ts `filterLogs`, lib/logs/log-severity.ts, lib/logs/log-clipboard.ts), built from the
// daemon's `docker logs` lines. Pure so the root vitest covers it.
//
// Self-host divergence: the platform's provider hands each line a level; `docker logs` hands none. A line's level is
// read from the line itself where the app wrote one (a JSON `level`, logfmt `level=`, a leading `ERROR:`/`[warn]`, the
// nginx and Postgres forms) and otherwise left blank, as the console leaves a line the provider assigned no level.

export type LogSeverity = 'informational' | 'warning' | 'error'
export type SeverityFilter = LogSeverity | 'all'
export type SourceLine = { ts: string; level?: string; message: string; instance?: string }

export interface LogEntry {
  id: string
  /** Display timestamp in the viewer's zone, e.g. "Sep 14, 2026, 8:16 PM". Empty when the line carried none. */
  timestamp: string
  /** Unix seconds, for the time window; absent when the line carried no parseable timestamp. */
  instant?: number
  /** Absent when the line names no level: shown blank rather than guessed as informational. */
  severity?: LogSeverity
  message: string
  instance?: string
  /** The daemon's own record, copied verbatim as JSON. */
  raw: SourceLine
}

export const SEVERITY_LABELS: Record<LogSeverity, string> = {
  informational: 'Informational',
  warning: 'Warning',
  error: 'Error',
}

export const SEVERITY_OPTIONS: readonly { value: SeverityFilter; label: string }[] = [
  { value: 'all', label: 'All severities' },
  { value: 'informational', label: 'Informational' },
  { value: 'warning', label: 'Warning' },
  { value: 'error', label: 'Error' },
]

/** The console's bucketing of a level word. */
export function toSeverity(level: string | undefined): LogSeverity | undefined {
  const l = (level ?? '').toLowerCase()
  if (!l) return undefined
  if (l.startsWith('err') || l === 'fatal' || l === 'panic' || l === 'crit' || l === 'critical') return 'error'
  if (l.startsWith('warn')) return 'warning'
  return 'informational'
}

const PINO_LEVELS: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' }
const LEVEL_WORD = '(fatal|panic|crit(?:ical)?|err(?:or)?|warn(?:ing)?|info|notice|debug|trace)'
// "ERROR: x", "[warn] x", "Error: connect ECONNREFUSED": any case, but the word must end at a separator, so
// "information about", "errors=0" and "Error handling is enabled" are not read as levels.
const LEADING = new RegExp(`^\\[?\\s*${LEVEL_WORD}\\b\\s*[\\]:|-]`, 'i')
// "INFO  listening on 8080", "WARN disk at 90%": a bare space counts only after an all-caps level word.
const LEADING_CAPS = /^(FATAL|PANIC|CRIT(?:ICAL)?|ERR(?:OR)?|WARN(?:ING)?|INFO|NOTICE|DEBUG|TRACE)\s/
// nginx error log: "2026/09/14 20:00:00 [error] 29#29: ..."
const NGINX = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} \[(\w+)\]/
// Postgres: "2026-09-14 20:00:00.123 UTC [1] ERROR:  relation does not exist"
const POSTGRES = /^\d{4}-\d{2}-\d{2} [\d:.]+ \S+ \[\d+\] ([A-Z]+\d?):/
const LOGFMT = /(?:^|\s)level=("?)(\w+)\1(?:\s|$)/i

/** The level a line names, from the daemon when it has one, else from what the app wrote into it. */
export function levelOf(line: { level?: string; message: string }): string | undefined {
  if (line.level) return line.level
  const m = line.message.trimStart()
  if (m.startsWith('{')) {
    try {
      const o = JSON.parse(m) as Record<string, unknown>
      const v = o.level ?? o.severity ?? o.lvl
      if (typeof v === 'string' && v) return v
      if (typeof v === 'number') return PINO_LEVELS[v]
    } catch {
      // Not JSON after all: fall through to the text forms.
    }
  }
  return NGINX.exec(m)?.[1] ?? POSTGRES.exec(m)?.[1] ?? LOGFMT.exec(m)?.[2] ?? LEADING.exec(m)?.[1] ?? LEADING_CAPS.exec(m)?.[1]
}

/** The console's log timestamp, in the viewer's zone. `timeZone` exists for tests. */
export function formatLogTime(at: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(at)
}

export function mapLogLines(lines: readonly SourceLine[], timeZone?: string): LogEntry[] {
  return lines.map((line, index) => {
    const at = line.ts ? new Date(line.ts) : null
    const valid = at && !Number.isNaN(at.getTime()) ? at : null
    return {
      id: `${line.ts || 'line'}-${index}`,
      timestamp: valid ? formatLogTime(valid, timeZone) : '',
      instant: valid ? Math.floor(valid.getTime() / 1000) : undefined,
      severity: toSeverity(levelOf(line)),
      message: line.message,
      instance: line.instance,
      raw: line,
    }
  })
}

export interface LogFilterState {
  query: string
  severity: SeverityFilter
  /** Unix-second window; stamped lines outside it are dropped. A line with no timestamp is kept: the daemon merges
   *  docker's own diagnostics into the stream unstamped, and those are the lines that explain an odd-looking tail. */
  window?: { from: number; to: number }
}

/** Message substring + severity + time window, applied together. */
export function filterLogs(entries: readonly LogEntry[], { query, severity, window }: LogFilterState): LogEntry[] {
  const q = query.trim().toLowerCase()
  return entries.filter((e) => {
    if (window && e.instant !== undefined && (e.instant < window.from || e.instant > window.to)) return false
    if (severity !== 'all' && e.severity !== severity) return false
    if (q && !e.message.toLowerCase().includes(q)) return false
    return true
  })
}

/** The oldest loaded line's instant: the honest left edge of what the daemon returned. */
export function oldestInstant(entries: readonly LogEntry[]): number | undefined {
  let min: number | undefined
  for (const e of entries) if (e.instant !== undefined && (min === undefined || e.instant < min)) min = e.instant
  return min
}

/** What the window does to the tail. The daemon answers the recent tail whatever the range (the console's platform
 *  serves the window), so the range can only subtract: `hidden` counts the lines the search and severity would show
 *  that the window alone takes away, which the page says rather than presenting a quiet table. */
export function windowCoverage(entries: readonly LogEntry[], state: LogFilterState): { hidden: number } {
  if (!state.window) return { hidden: 0 }
  return { hidden: filterLogs(entries, { ...state, window: undefined }).length - filterLogs(entries, state).length }
}

/** Mirrors the table's columns; absent fields are dropped rather than padded into blank columns. */
export function logsToPlainText(entries: readonly LogEntry[]): string {
  return entries
    .map((e) => [e.timestamp, e.severity ? SEVERITY_LABELS[e.severity] : '', e.message].filter(Boolean).join('  '))
    .join('\n')
}

/** One record copies as its object, a list as an array. */
export function logsToJson(entries: readonly LogEntry[]): string {
  const raw = entries.length === 1 ? entries[0]!.raw : entries.map((e) => e.raw)
  return JSON.stringify(raw, null, 2)
}
