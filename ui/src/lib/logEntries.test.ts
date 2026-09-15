import { describe, expect, it } from 'vitest'
import { filterLogs, formatLogTime, levelOf, logsToJson, logsToPlainText, mapLogLines, toSeverity } from './logEntries'

describe('levelOf', () => {
  it('prefers the level the daemon gave', () => {
    expect(levelOf({ level: 'warn', message: 'ERROR: x' })).toBe('warn')
  })
  it('reads a JSON level, a severity field and a pino number', () => {
    expect(levelOf({ message: '{"level":"error","msg":"boom"}' })).toBe('error')
    expect(levelOf({ message: '{"severity":"WARNING"}' })).toBe('WARNING')
    expect(levelOf({ message: '{"level":40,"msg":"slow"}' })).toBe('warn')
  })
  it('reads logfmt, leading words, nginx and Postgres forms', () => {
    expect(levelOf({ message: 'ts=1 level=warn msg=slow' })).toBe('warn')
    expect(levelOf({ message: 'ERROR: disk full' })).toBe('ERROR')
    expect(levelOf({ message: '[warn] retrying' })).toBe('warn')
    expect(levelOf({ message: 'INFO  listening on 8080' })).toBe('INFO')
    expect(levelOf({ message: 'Error: connect ECONNREFUSED 127.0.0.1:5432' })).toBe('Error')
    expect(levelOf({ message: '2026/09/14 20:00:00 [error] 29#29: open() failed' })).toBe('error')
    expect(levelOf({ message: '2026-09-14 20:00:00.123 UTC [1] FATAL:  role "x" does not exist' })).toBe('FATAL')
  })
  it('does not read a level out of ordinary words', () => {
    expect(levelOf({ message: 'information about the request' })).toBeUndefined()
    expect(levelOf({ message: 'errors=0 warnings=0' })).toBeUndefined()
    expect(levelOf({ message: '172.17.0.1 - - "GET / HTTP/1.1" 200' })).toBeUndefined()
    expect(levelOf({ message: '{not json' })).toBeUndefined()
  })
})

describe('toSeverity', () => {
  it('buckets as the console does, and leaves no level blank', () => {
    expect(toSeverity('FATAL')).toBe('error')
    expect(toSeverity('err')).toBe('error')
    expect(toSeverity('Warning')).toBe('warning')
    expect(toSeverity('LOG')).toBe('informational')
    expect(toSeverity(undefined)).toBeUndefined()
  })
})

describe('mapLogLines', () => {
  it('formats the time in the given zone, keeps the instant and the raw line', () => {
    const [e] = mapLogLines([{ ts: '2026-09-14T20:16:05.123Z', message: 'ERROR: x', instance: 'io-a-main-app-web' }], 'UTC')
    expect(e!.timestamp).toBe(formatLogTime(new Date('2026-09-14T20:16:05Z'), 'UTC'))
    expect(e!.timestamp).toBe('Sep 14, 2026, 8:16 PM')
    expect(e!.instant).toBe(Math.floor(Date.parse('2026-09-14T20:16:05.123Z') / 1000))
    expect(e!.severity).toBe('error')
    expect(e!.raw.instance).toBe('io-a-main-app-web')
  })
  it('leaves a line without a timestamp unstamped', () => {
    const [e] = mapLogLines([{ ts: '', message: 'plain' }])
    expect(e!.timestamp).toBe('')
    expect(e!.instant).toBeUndefined()
    expect(e!.severity).toBeUndefined()
  })
})

describe('filterLogs and copying', () => {
  const entries = mapLogLines([
    { ts: '2026-09-14T20:00:00Z', message: 'INFO boot' },
    { ts: '2026-09-14T20:30:00Z', message: 'ERROR: Disk full' },
    { ts: '', message: 'no time' },
  ], 'UTC')
  const t = (iso: string) => Date.parse(iso) / 1000

  it('applies search case-insensitively, severity and the window together', () => {
    expect(filterLogs(entries, { query: 'disk', severity: 'all' }).map((e) => e.message)).toEqual(['ERROR: Disk full'])
    expect(filterLogs(entries, { query: '', severity: 'informational' }).map((e) => e.message)).toEqual(['INFO boot'])
    const window = { from: t('2026-09-14T20:10:00Z'), to: t('2026-09-14T21:00:00Z') }
    expect(filterLogs(entries, { query: '', severity: 'all', window }).map((e) => e.message)).toEqual(['ERROR: Disk full'])
  })
  it('copies plain text in table order and JSON as the raw lines', () => {
    expect(logsToPlainText(entries.slice(0, 2))).toBe('Sep 14, 2026, 8:00 PM  Informational  INFO boot\nSep 14, 2026, 8:30 PM  Error  ERROR: Disk full')
    expect(logsToPlainText([entries[2]!])).toBe('no time')
    expect(JSON.parse(logsToJson([entries[1]!]))).toEqual({ ts: '2026-09-14T20:30:00Z', message: 'ERROR: Disk full' })
    expect(JSON.parse(logsToJson(entries.slice(0, 2)))).toHaveLength(2)
  })
})
