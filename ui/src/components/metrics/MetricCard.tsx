// The console's observability card (insta-frontend components/metrics/metric-cards.tsx, per the Figma
// metrics design): a bordered header (icon and title left, current value right) over a card-filling
// chart, with a colored-dot legend beneath when the card draws more than one line.

import { ArrowUpDown, Cpu, Gauge, HardDrive, MemoryStick, type LucideIcon } from 'lucide-react'
import { seriesStats, type MetricCardData } from '../../lib/metrics'
import { TimeSeriesChart } from './TimeSeriesChart'

const cardIcons: Record<string, LucideIcon> = {
  cpu_pct: Cpu,
  cpu_cores: Cpu,
  memory_pct: MemoryStick,
  memory_used_bytes: MemoryStick,
  network_bytes_rate: ArrowUpDown,
  egress_bytes_rate: ArrowUpDown,
  db_storage_bytes: HardDrive,
}

/** Colored-dot legend row beneath the chart, one entry per series. */
function Legend({ card }: { card: MetricCardData }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-1">
      {card.lines.map((line) => (
        <span key={line.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-2 rounded-full" style={{ backgroundColor: line.color }} />
          {line.name}
        </span>
      ))}
    </div>
  )
}

/** History (per-point readings) lives in the chart's hover tooltip; there is no AVG/MAX/LATEST row. */
export function MetricCard({ card, byService = false }: {
  card: MetricCardData
  /** Lines are SERVICES, not metrics: the legend becomes identity, and no one line is "the" value. */
  byService?: boolean
}) {
  const Icon = cardIcons[card.id] ?? Gauge
  const { latest } = seriesStats(card)

  return (
    <div className="flex h-[400px] flex-col overflow-hidden rounded-lg border border-border bg-card pb-3">
      <div className="flex items-center gap-3 border-b border-border p-4">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <Icon className="size-5 shrink-0 text-muted-foreground" />
          <span className="truncate text-[13px] text-muted-foreground">{card.title}</span>
        </div>
        {/* Suppressed when lines are services: `latest` is the FRONT-MOST line's, which reads as the
            card's own number while naming no one. */}
        {!byService && (
          <>
            {card.summaryLabel && <span className="text-xs text-muted-foreground">{card.summaryLabel}</span>}
            <span className="text-xl leading-7 font-medium tabular-nums">{latest}</span>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 px-2 pt-4">
        <TimeSeriesChart card={card} height="100%" />
      </div>
      {/* One series is named by its title already; a project-scoped card always shows it. */}
      {(byService || card.lines.length > 1) && (
        <div className="px-4 pt-1">
          <Legend card={card} />
        </div>
      )}
    </div>
  )
}
