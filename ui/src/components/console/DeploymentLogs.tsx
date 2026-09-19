// The console's Deployment Logs tab (insta-frontend services/deployment-logs.tsx): a time-ranged
// table of what deployed, restarted, slept and woke, per service. Self-host divergences (also in
// lib/deployEvents.ts): the rows come from the daemon's audit stream (`GET /events`) rather than a
// machine-operation feed, so there is no Status or Machine column — the daemon runs one machine
// per group and a failed deploy reports at the call site instead of emitting an event. The widest
// preset is 7 day, the console's own default here.

import { useState } from 'react'
import { cn, Skeleton } from '@insforge/ui'
import { api, type Service } from '../../api'
import { usePoll } from '../../hooks'
import { activeRange, localZoneAbbr, PRESET_KEYS, tickedRange, type ActiveRange } from '../../lib/metricRanges'
import { TimeRangePicker } from '../metrics/TimeRangePicker'
import { deployEventRows } from '../../lib/deployEvents'
import { formatLocalDateTime } from '../../lib/activity'

const WIDEST_RANGE = PRESET_KEYS[PRESET_KEYS.length - 1]
/** The events route's ceiling. The default window is the widest preset (7 day), so on a branch
 *  with more than 1000 audit events in that span the OLDEST rows fall off this one page — a
 *  documented truncation, pending a time-windowed events query on the daemon. */
const EVENTS_LIMIT = 1000

function Th({ children, className }: { children?: string; className?: string }) {
  return <th className={cn('border-b border-border px-4 py-3 text-left text-[13px] font-normal text-muted-foreground', className)}>{children}</th>
}

export function DeploymentLogsPanel({ projectId, branch, service }: {
  projectId: string; branch: string; service: Service
}) {
  const [range, setRange] = useState<ActiveRange>(() => activeRange(WIDEST_RANGE, Date.now()))
  // The PROJECT stream, unfiltered: registration events carry branch null and a server-side
  // `?branch=` filter would drop them (deployEvents.ts scopes per branch client-side).
  const { data: events, error } = usePoll(() => api.events(projectId, EVENTS_LIMIT), [projectId], 10000)
  // A preset window rolls forward with the clock, like the charts'.
  const active = tickedRange(range, Date.now())
  const rows = deployEventRows(events ?? [], { type: service.type, name: service.name },
    { fromMs: active.window.from * 1000, toMs: active.window.to * 1000 }, branch)
  const emptyMessage = error ? 'Deploy events are unavailable right now.' : 'No deploy events in the selected range.'

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <TimeRangePicker value={active} onChange={setRange} align="end" />
      </div>
      {!events && !error ? (
        <Skeleton className="h-40 rounded-lg" />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="max-h-[70vh] overflow-y-auto overscroll-contain">
            <table className="w-full table-fixed">
              <thead className="sticky top-0 z-10 bg-card">
                <tr>
                  <Th className="w-52">{`Date (${localZoneAbbr(new Date())})`}</Th>
                  <Th className="w-48">Event</Th>
                  <Th>Detail</Th>
                  <Th className="w-28">Origin</Th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={4} className="px-4 py-10 text-center text-sm text-muted-foreground">{emptyMessage}</td></tr>
                ) : rows.map((row) => (
                  <tr key={row.id} className="border-b border-border align-top last:border-b-0 hover:bg-alpha-4">
                    <td className="px-4 py-2 text-sm text-muted-foreground">{formatLocalDateTime(row.created)}</td>
                    <td className="truncate px-4 py-2 font-mono text-[13px]">{row.kind}</td>
                    <td className="px-4 py-2 text-[13px] break-words text-muted-foreground">{row.detail || '—'}</td>
                    <td className="px-4 py-2 text-sm text-muted-foreground">{row.origin}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
