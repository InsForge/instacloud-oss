// The console's log toolbar and table (insta-frontend logs/log-filter-bar.tsx, log-copy-menu.tsx, severity-badge.tsx,
// logs-table.tsx): Search logs, a Severity menu and Copy Logs (Plain text / JSON) over a Time (zone) / Severity / Logs
// table that scrolls in its own card with a sticky header.
//
// Self-host divergences: copying goes through lib/clipboard.ts `copyText`, which also works over plain HTTP on a LAN
// address where `navigator.clipboard` is undefined; there is no row detail sheet yet; and the table keeps the live
// tail pinned to the newest line while the reader is already at the bottom.

import { useLayoutEffect, useRef, useState } from 'react'
import {
  Button, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, SearchInput,
} from '@insforge/ui'
import { Check, ChevronDown, Copy } from 'lucide-react'
import { copyText } from '../../lib/clipboard'
import { instanceLabel } from '../../lib/instanceLabels'
import {
  logsToJson, logsToPlainText, SEVERITY_LABELS, SEVERITY_OPTIONS, type LogEntry, type LogSeverity, type SeverityFilter,
} from '../../lib/logEntries'
import { localZoneAbbr } from '../../lib/metricRanges'

const SEVERITY_STYLES: Record<LogSeverity, string> = {
  informational: 'bg-alpha-8 text-muted-foreground',
  warning: 'bg-[#713f12] text-[#fde047]',
  error: 'bg-[#7f1d1d] text-[#fee2e2]',
}

export function SeverityBadge({ severity }: { severity: LogSeverity }) {
  return (
    <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium', SEVERITY_STYLES[severity])}>
      {SEVERITY_LABELS[severity]}
    </span>
  )
}

export function LogCopyMenu({ entries, className }: { entries: readonly LogEntry[]; className?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async (text: string) => {
    if (!(await copyText(text))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={entries.length === 0}>
        <Button variant="secondary" size="sm" className={cn('h-8 gap-1.5', className)} disabled={entries.length === 0}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? 'Copied' : 'Copy Logs'}
          <ChevronDown className="size-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void copy(logsToPlainText(entries))}>Plain text</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copy(logsToJson(entries))}>JSON</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Search + Severity + Copy Logs. Copy takes what the filters left on screen, not the whole fetched tail. */
export function LogFilterBar({ query, onQuery, severity, onSeverity, filtered, className }: {
  query: string; onQuery: (q: string) => void; severity: SeverityFilter; onSeverity: (s: SeverityFilter) => void
  filtered: readonly LogEntry[]; className?: string
}) {
  const label = severity === 'all' ? 'Severity' : SEVERITY_LABELS[severity]
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <SearchInput value={query} onChange={onQuery} placeholder="Search logs" className="w-64" debounceTime={0} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="sm" className="h-8 gap-1.5">
            {label}
            <ChevronDown className="size-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {SEVERITY_OPTIONS.map((o) => (
            <DropdownMenuItem key={o.value} onSelect={() => onSeverity(o.value)}>{o.label}</DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <LogCopyMenu entries={filtered} className="ml-auto" />
    </div>
  )
}

function Th({ children, className }: { children: string; className?: string }) {
  return <th className={cn('border-b border-border px-4 py-3 text-left text-[13px] font-normal text-muted-foreground', className)}>{children}</th>
}

/** Time | Severity | Logs, oldest first, no dividers or truncation so a split message does not read as fragments. */
export function LogsTable({ logs, emptyMessage }: { logs: readonly LogEntry[]; emptyMessage: string }) {
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  // Follow the tail only while the reader is at the bottom: a poll that lands while they scroll back must not yank
  // them to the end.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [logs])
  const instances = new Set(logs.map((l) => l.instance))
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div ref={scroller} className="max-h-[70vh] overflow-y-auto overscroll-contain"
        onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}>
        <table className="w-full table-fixed">
          <thead className="sticky top-0 z-10 bg-card">
            <tr>
              <Th className="w-52">{`Time (${localZoneAbbr(new Date())})`}</Th>
              <Th className="w-36">Severity</Th>
              <Th>Logs</Th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 ? (
              <tr><td colSpan={3} className="px-4 py-10 text-center text-sm text-muted-foreground">{emptyMessage}</td></tr>
            ) : logs.map((log) => (
              <tr key={log.id} className="align-top transition-colors hover:bg-alpha-4">
                <td className="px-4 py-2 text-[13px] whitespace-nowrap text-muted-foreground">{log.timestamp}</td>
                <td className="px-4 py-2">{log.severity ? <SeverityBadge severity={log.severity} /> : null}</td>
                <td className="px-4 py-2 font-mono text-[13px] break-words whitespace-pre-wrap">
                  {instances.size > 1 && log.instance && <span className="mr-3 text-info">{instanceLabel(log.instance)}</span>}
                  {log.message}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
