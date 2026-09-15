// The Logs page and a service's Runtime Logs tab (insta-frontend logs/runtime-logs-tab.tsx): the console's filter bar
// (Search logs, Severity, Copy Logs) and time range picker over a Time / Severity / Logs table.
//
// Self-host divergences: the daemon answers the recent tail of `docker logs` whatever the range (no from/to), so the
// range can only narrow that tail here. It starts at the widest preset, as the console starts any view over an
// endpoint that takes no range, and the page says how many loaded lines the range hides, with Show all lines to
// lift it: a sleeping service's last lines, or ones older than any preset, stay one click away. The picker offers
// the metrics presets (up to 3 days) rather than the console's 7; there is no histogram yet; and the tail refreshes
// every 5s instead of on range change.

import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Button, Skeleton, Tab, Tabs } from '@insforge/ui'
import { Moon } from 'lucide-react'
import { api, obsComponentFor, type ObsComponent } from '../api'
import { usePoll } from '../hooks'
import { healthFor } from '../lib/status'
import { filterLogs, formatLogTime, mapLogLines, oldestInstant, windowCoverage, type SeverityFilter } from '../lib/logEntries'
import { activeRange, PRESET_KEYS, tickedRange, type ActiveRange } from '../lib/metricRanges'
import { ConsolePage } from '../components/console/ConsolePage'
import { LogFilterBar, LogsTable } from '../components/console/LogParts'
import { TimeRangePicker } from '../components/metrics/TimeRangePicker'

type Component = ObsComponent

/** The daemon's cap on one read: the most the range can narrow. */
const TAIL_LINES = 1000
/** The widest preset: a view over an endpoint that takes no range starts here, or the default hides what it carries. */
const WIDEST_RANGE = PRESET_KEYS[PRESET_KEYS.length - 1]!

/** The live container tail, for the Logs page and a service's Runtime Logs tab. `service` narrows
 *  it to one service's container. Reading logs never wakes anything. */
export function LogsPanel({ projectId, branch, component, service }: {
  projectId: string; branch: string; component: Component; service?: { name: string; type: string }
}) {
  // Ask the daemon for THIS service's container rather than filtering the component stream here:
  // it truncates the merged stream to the limit before returning it, so a noisy sibling could use
  // up the whole window and leave the selected service reading "No logs yet."
  const { data, error } = usePoll(
    () => api.logs(projectId, component, branch, TAIL_LINES, service?.name),
    [projectId, branch, component, service?.name],
  )
  const { data: services } = usePoll(() => api.services(projectId, branch), [projectId, branch], 15000)
  const { data: health } = usePoll(() => api.runtimeHealth(projectId, branch), [projectId, branch], 15000)
  const [range, setRange] = useState<ActiveRange>(() => activeRange(WIDEST_RANGE, Date.now()))
  // Show all lines: the range stays picked but is not applied, until another range is picked.
  const [showAll, setShowAll] = useState(false)
  const [query, setQuery] = useState('')
  const [severity, setSeverity] = useState<SeverityFilter>('all')

  // Name alone is not a key: a compute service and a database can share one, and then the sleeping
  // banner was decided by both. The selected service is identified by name AND type; the whole-page
  // view takes every service the requested component observes.
  const wanted = (services ?? []).filter((s) => service
    ? s.name === service.name && s.type === service.type
    : obsComponentFor(s.type) === component)
  const standby = wanted.length > 0 && wanted.every((s) => healthFor(health, s.id)?.status === 'standby')

  const loaded = useMemo(() => mapLogLines(data?.lines ?? []), [data])
  // A preset rolls forward with every poll, so a line that just arrived is inside "last hour"; a custom range stays put.
  const { filtered, hidden } = useMemo(() => {
    const state = { query, severity, window: showAll ? undefined : tickedRange(range, Date.now()).window }
    return { filtered: filterLogs(loaded, state), hidden: windowCoverage(loaded, state).hidden }
  }, [loaded, range, showAll, query, severity])
  const oldest = oldestInstant(loaded)
  const capped = (data?.lines.length ?? 0) >= TAIL_LINES

  if (!data && !error) return <Skeleton className="h-96 rounded-lg" />
  return (
    <div className="flex flex-col gap-3">
      {standby && (
        <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Moon className="size-3.5" /> Sleeping; showing the last lines before it went to sleep.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <LogFilterBar query={query} onQuery={setQuery} severity={severity} onSeverity={setSeverity} filtered={filtered}
          className="min-w-0 flex-1" />
        <TimeRangePicker value={range} onChange={(next) => { setRange(next); setShowAll(false) }} align="end" />
      </div>
      {/* Beside the table, not instead of it: one failed 5s poll must not blank lines that are still good. */}
      {error && (
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-destructive">{error.message}</div>
      )}
      {(hidden > 0 || showAll) && (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          {showAll ? (
            <>
              <span>Showing every loaded line, whatever the range.</span>
              <Button variant="secondary" size="sm" className="h-7" onClick={() => setShowAll(false)}>Apply range</Button>
            </>
          ) : (
            <>
              <span>{hidden === 1 ? '1 loaded line is' : `${hidden} loaded lines are`} outside the selected range.</span>
              <Button variant="secondary" size="sm" className="h-7" onClick={() => setShowAll(true)}>Show all lines</Button>
            </>
          )}
        </div>
      )}
      {data && (
        <LogsTable logs={filtered}
          emptyMessage={loaded.length === 0
            ? component === 'compute'
              ? 'No logs yet. Deploy an app to this branch and its container output lands here.'
              : 'No logs yet. The database has not written any log lines.'
            : hidden > 0 ? 'No logs in the selected range.' : 'No logs match your filters or range.'} />
      )}
      <p className="text-xs text-muted-foreground">
        Tailed live from this branch&apos;s containers ({data?.source ?? 'docker-logs'}); refreshes every 5s.
        {capped && oldest !== undefined && ` Loaded lines start ${formatLogTime(new Date(oldest * 1000))}; older ones aren't fetched.`}
      </p>
    </div>
  )
}

export function Logs() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  const [component, setComponent] = useState<Component>('compute')
  return (
    <ConsolePage title="Logs"
      action={
        <Tabs value={component} onValueChange={setComponent}>
          <Tab value="compute">App</Tab>
          <Tab value="db">Database</Tab>
        </Tabs>
      }>
      <LogsPanel projectId={projectId} branch={branch} component={component} />
    </ConsolePage>
  )
}
