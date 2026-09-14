// The console's metric charts (insta-frontend components/metrics/metric-charts.tsx), shared by the
// environment Observability page and a service's Metrics tab: a 1h / 6h / 24h / 3d range picker over
// a grid of cards, one request per component merged onto the same cards, and inline loading, error
// and note states. Missing series draw as flat zero lines ("no data" reads as 0 usage); the empty
// state appears only when the daemon sends a `note`, so nothing is fabricated for a source that
// doesn't exist.
//
// Self-host divergences: fetched with usePoll every 30 s — the daemon samples every 30 s — instead of
// React Query; and `also` is a list, since a box can run Redis, MySQL and MongoDB beside Postgres.

import { useMemo, useState } from 'react'
import { Button, cn, EmptyState, Skeleton } from '@insforge/ui'
import { Gauge } from 'lucide-react'
import { api } from '../../api'
import { usePoll } from '../../hooks'
import { cardsForSources, type MetricComponent, type ZeroFillWindow } from '../../lib/metrics'
import { MetricCard } from './MetricCard'

const RANGES = {
  '1h': { seconds: 3_600, step: '60s', stepSeconds: 60 },
  '6h': { seconds: 21_600, step: '5m', stepSeconds: 300 },
  '24h': { seconds: 86_400, step: '15m', stepSeconds: 900 },
  '3d': { seconds: 259_200, step: '1h', stepSeconds: 3_600 },
} as const

type RangeKey = keyof typeof RANGES

/** The window part of a query, shared by every component the view merges. */
type MetricsWindow = { from?: number; to?: number; step?: string }

interface ActiveRange {
  range: RangeKey
  /** Empty for 1h — see activeRange(). */
  window: MetricsWindow
  /** The zero-fill time grid matching `window`'s (possibly implicit) span. */
  zeroWindow: ZeroFillWindow
}

/** How often the charts refresh: the daemon samples every 30 s, so a faster poll redraws the same points. */
const REFRESH_MS = 30_000

/**
 * The 1h window omits from/to so it follows the daemon's default "last hour ending now"; other ranges
 * get an explicit window computed at click time. Every component the view merges is asked for the
 * SAME span, or the lines would not be comparable.
 */
function activeRange(range: RangeKey): ActiveRange {
  const now = Math.floor(Date.now() / 60_000) * 60
  const window: MetricsWindow = range === '1h' ? {} : { from: now - RANGES[range].seconds, to: now, step: RANGES[range].step }
  return {
    range,
    window,
    zeroWindow: { from: window.from ?? now - RANGES[range].seconds, to: window.to ?? now, stepSeconds: RANGES[range].stepSeconds },
  }
}

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
  const [active, setActive] = useState<ActiveRange>(() => activeRange('1h'))
  // Compare by VALUE: callers rebuild these arrays each render, so identity would refetch always.
  const sourcesKey = JSON.stringify([services ?? null, also ?? null])

  const { data, error, reload } = usePoll(async () => {
    // 1h follows the clock on every refresh, as the default query does; a longer range stays on the
    // window it was picked with.
    const current = active.range === '1h' ? activeRange('1h') : active
    // One failing source costs its lines, not the page.
    const settle = (c: MetricComponent, g?: string) => api.metrics(projectId, c, branch, g, current.window).catch(() => undefined)
    const [primary, ...rest] = await Promise.all([settle(component, group), ...(also ?? []).map((s) => settle(s.component))])
    if (!primary && rest.every((r) => !r)) throw new Error("The daemon couldn't return metrics right now.")
    return { range: current.range, zeroWindow: current.zeroWindow, primary, rest }
  }, [projectId, component, branch, group, active, sourcesKey], REFRESH_MS)

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
  const fetching = Boolean(data) && data!.range !== active.range
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
                  onClick={() => setActive(activeRange(option))}
                  className={cn(
                    'rounded px-3 py-1 text-sm transition-colors',
                    active.range === option ? 'bg-alpha-8 font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {!data && !error ? (
        <div className={grid}>
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[400px] rounded-lg" />)}
        </div>
      ) : !data ? (
        // Only when NO source answered; one failing source costs its lines, not the page.
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card px-6 py-16 text-center">
          <p className="text-base font-medium">Metrics unavailable</p>
          <p className="text-sm text-muted-foreground">{error?.message}</p>
          <Button variant="secondary" onClick={reload}>Retry</Button>
        </div>
      ) : note ? (
        <div className="rounded-lg border border-border bg-card py-16">
          <EmptyState icon={Gauge} title="No metrics available" description={note} />
        </div>
      ) : (
        <div className={grid}>
          {cards.map((card) => <MetricCard key={card.id} card={card} byService={byService} />)}
        </div>
      )}
    </div>
  )
}
