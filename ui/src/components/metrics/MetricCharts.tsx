// The console's metric charts (insta-frontend components/metrics/metric-charts.tsx), shared by the
// branch Observability page and a service's Metrics tab: the console's time range picker over
// a grid of cards, one request per component merged onto the same cards, and inline loading, error
// and note states. Missing series draw as flat zero lines ("no data" reads as 0 usage); when the daemon
// sends a `note` (nothing to measure) the cards draw EMPTY, as the console's do, with the note once above
// them, so nothing is fabricated for a source that doesn't exist.
//
// Self-host divergences: fetched with usePoll every 30 s — the daemon samples every 30 s — instead of
// React Query, with the window recomputed on every poll (lib/metricRanges.ts); `also` is a list, since
// a box can run Redis, MySQL and MongoDB beside Postgres; and a source whose request fails draws no
// lines at all rather than zero lines (lib/metrics.ts, mergeMetricSources).

import { useMemo, useState } from 'react'
import { Button, cn, Skeleton } from '@insforge/ui'
import { api } from '../../api'
import { usePoll } from '../../hooks'
import { cardsForSources, emptyMetricCards, type MetricComponent } from '../../lib/metrics'
import { activeRange, tickedRange, type ActiveRange } from '../../lib/metricRanges'
import { TimeRangePicker } from './TimeRangePicker'
import { metricChartsView } from '../../lib/metricChartsView'
import { MetricCard } from './MetricCard'

/** How often the charts refresh: the daemon samples every 30 s, so a faster poll redraws the same points. */
const REFRESH_MS = 30_000

/** One metrics source a view draws from: a component and the services it should account for. */
export interface MetricSource {
  component: MetricComponent
  /** Every service of this component, so an idle one still gets a flat line. */
  services?: string[]
}

export function MetricCharts({ projectId, component, branch, group, lineName, services, also, title, showRangePicker = true }: {
  projectId: string
  component: MetricComponent
  branch: string
  /** The service the metrics belong to. */
  group?: string
  /** Labels each chart line with the owning service. */
  lineName?: string
  /** Every service these charts cover. The only way an idle one is drawn — it reports no series. */
  services?: string[]
  /** More sources merged onto the same cards (databases). Each request fails independently. */
  also?: MetricSource[]
  /** Optional page title rendered inline with the range picker. */
  title?: string
  /** Whether to show the range picker; every current view does, as on the console. */
  showRangePicker?: boolean
}) {
  const [active, setActive] = useState<ActiveRange>(() => activeRange('1h', Date.now()))
  // What the picked range IS: a preset by its key (its window moves with the clock), a custom range by its
  // two pinned ends.
  const rangeKey = active.range === 'custom' ? `custom:${active.window.from}-${active.window.to}` : active.range
  // Compare by VALUE: callers rebuild these arrays each render, so identity would refetch always.
  const sourcesKey = JSON.stringify([services ?? null, also ?? null])
  // What the data is OF. The range is deliberately not part of it: another range of the same services
  // stays on screen dimmed while the new one loads, as on the console, and names nobody wrongly.
  const scope = JSON.stringify([projectId, branch, component, group ?? null, lineName ?? null, sourcesKey])

  const { data, error, reload } = usePoll(async () => {
    const fetchedFor = scope
    // Computed now, on every poll, and shared by every source this poll asks: a window fixed when the
    // range was picked would never take in a new sample.
    const current = tickedRange(active, Date.now())
    // One failing source costs its lines, not the page; `undefined` is how its failure is carried.
    const settle = (c: MetricComponent, g?: string) => api.metrics(projectId, c, branch, g, current.window).catch(() => undefined)
    const [primary, ...rest] = await Promise.all([settle(component, group), ...(also ?? []).map((s) => settle(s.component))])
    if (!primary && rest.every((r) => !r)) throw new Error("The daemon couldn't return metrics right now.")
    return { fetchedFor, range: rangeKey, zeroWindow: current.zeroWindow, primary, rest }
  }, [projectId, component, branch, group, rangeKey, sourcesKey], REFRESH_MS)

  const { cards, note, byService } = useMemo(() => {
    if (!data) return { cards: [], note: undefined, byService: false }
    return cardsForSources(
      [
        { result: data.primary, component, services },
        ...(also ?? []).map((s, i) => ({ result: data.rest[i], component: s.component, services: s.services })),
      ],
      data.zeroWindow,
      lineName,
      component,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sourcesKey stands in for services/also
  }, [data, lineName, component, sourcesKey])

  // The picked range has not answered yet: the previous range's cards stay, dimmed like the console's refetch.
  const fetching = Boolean(data) && data!.range !== rangeKey
  const view = metricChartsView({ hasData: Boolean(data), error, note, fetchedFor: data?.fetchedFor, scope })
  const grid = 'grid grid-cols-1 gap-3 lg:grid-cols-2'

  return (
    <div className="flex flex-col gap-4">
      {(title || showRangePicker) && (
        // Untitled means a tab inside a service detail, where the console starts the picker at the left.
        <div className={cn('flex flex-wrap items-center gap-3', title && 'justify-between')}>
          {title && <h1 className="text-[32px] leading-12 font-bold">{title}</h1>}
          {showRangePicker && (
            <TimeRangePicker value={active} onChange={setActive} busy={fetching} align={title ? 'end' : 'start'} />
          )}
        </div>
      )}

      {view === 'loading' ? (
        <div className={grid}>
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[400px] rounded-lg" />)}
        </div>
      ) : view === 'unavailable' ? (
        // The LATEST poll had no source answer (one failing source costs only its lines). Shown even
        // over data an earlier poll left behind: old observations must not read as current.
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card px-6 py-16 text-center">
          <p className="text-base font-medium">Metrics unavailable</p>
          <p className="text-sm text-muted-foreground">{error?.message}</p>
          <Button variant="secondary" onClick={reload}>Retry</Button>
        </div>
      ) : view === 'note' ? (
        // Nothing to measure: the console's empty charts, with the daemon's reason once above them.
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-muted-foreground">{note ? `${note.charAt(0).toUpperCase()}${note.slice(1)}.` : 'No metrics yet.'}</p>
          <div className={grid}>
            {emptyMetricCards(component).map((card) => (
              <MetricCard key={card.id} card={card}
                domain={data ? { from: data.zeroWindow.from, to: data.zeroWindow.to, step: data.zeroWindow.stepSeconds } : undefined} />
            ))}
          </div>
        </div>
      ) : (
        <div className={grid}>
          {cards.map((card) => (
            // The selected window, not the samples' extent: partial history shows where it sits in the range.
            <MetricCard key={card.id} card={card} byService={byService}
              domain={{ from: data!.zeroWindow.from, to: data!.zeroWindow.to, step: data!.zeroWindow.stepSeconds }} />
          ))}
        </div>
      )}
    </div>
  )
}
