// The console's metric charts (insta-frontend components/metrics/metric-charts.tsx), shared by the
// environment Observability page and a service's Metrics tab: a 1h / 6h / 24h / 3d range picker over
// a grid of cards, one request per component merged onto the same cards, and inline loading, error
// and note states. Missing series draw as flat zero lines ("no data" reads as 0 usage); the empty
// state appears only when the daemon sends a `note`, so nothing is fabricated for a source that
// doesn't exist.
//
// Self-host divergences: fetched with usePoll every 30 s — the daemon samples every 30 s — instead of
// React Query, with the window recomputed on every poll (lib/metricRanges.ts); `also` is a list, since
// a box can run Redis, MySQL and MongoDB beside Postgres; and a source whose request fails draws no
// lines at all rather than zero lines (lib/metrics.ts, mergeMetricSources).

import { useMemo, useState } from 'react'
import { Button, cn, EmptyState, Skeleton } from '@insforge/ui'
import { Gauge } from 'lucide-react'
import { api } from '../../api'
import { usePoll } from '../../hooks'
import { cardsForSources, type MetricComponent } from '../../lib/metrics'
import { activeRange, RANGES, type RangeKey } from '../../lib/metricRanges'
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
  /** The compute service-detail tab omits the range picker, as on the console. */
  showRangePicker?: boolean
}) {
  const [range, setRange] = useState<RangeKey>('1h')
  // Compare by VALUE: callers rebuild these arrays each render, so identity would refetch always.
  const sourcesKey = JSON.stringify([services ?? null, also ?? null])
  // What the data is OF. The range is deliberately not part of it: another range of the same services
  // stays on screen dimmed while the new one loads, as on the console, and names nobody wrongly.
  const scope = JSON.stringify([projectId, branch, component, group ?? null, lineName ?? null, sourcesKey])

  const { data, error, reload } = usePoll(async () => {
    const fetchedFor = scope
    // Computed now, on every poll, and shared by every source this poll asks: a window fixed when the
    // range was picked would never take in a new sample.
    const current = activeRange(range, Date.now())
    // One failing source costs its lines, not the page; `undefined` is how its failure is carried.
    const settle = (c: MetricComponent, g?: string) => api.metrics(projectId, c, branch, g, current.window).catch(() => undefined)
    const [primary, ...rest] = await Promise.all([settle(component, group), ...(also ?? []).map((s) => settle(s.component))])
    if (!primary && rest.every((r) => !r)) throw new Error("The daemon couldn't return metrics right now.")
    return { fetchedFor, range: current.range, zeroWindow: current.zeroWindow, primary, rest }
  }, [projectId, component, branch, group, range, sourcesKey], REFRESH_MS)

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
  const fetching = Boolean(data) && data!.range !== range
  const view = metricChartsView({ hasData: Boolean(data), error, note, fetchedFor: data?.fetchedFor, scope })
  const grid = 'grid grid-cols-1 gap-3 lg:grid-cols-2'

  return (
    <div className="flex flex-col gap-4">
      {(title || showRangePicker) && (
        <div className={cn('flex flex-wrap items-center gap-3', title ? 'justify-between' : 'justify-end')}>
          {title && <h1 className="text-[32px] leading-12 font-bold">{title}</h1>}
          {showRangePicker && (
            <div className={cn('flex items-center gap-0.5 rounded-md border border-border p-0.5', fetching && 'opacity-70')}>
              {(Object.keys(RANGES) as RangeKey[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setRange(option)}
                  className={cn(
                    'rounded px-3 py-1 text-sm transition-colors',
                    range === option ? 'bg-alpha-8 font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {option}
                </button>
              ))}
            </div>
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
        <div className="rounded-lg border border-border bg-card py-16">
          <EmptyState icon={Gauge} title="No metrics available" description={note} />
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
