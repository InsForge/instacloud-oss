// The console's metric chart (insta-frontend components/metrics/time-series-chart.tsx): a
// multi-series area chart over [unix seconds, value] points, gradient fill under each line, a
// horizontal-only grid, round clock ticks, and a dashed crosshair with a timestamped tooltip.

import { useId } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { clockTicks, formatClock, formatMetricValue, formatTimestamp, type MetricCardData } from '../../lib/metrics'

// The font size must arrive as CSS with a unit. recharts word-wraps a tick to the axis width and
// measures the text by assigning this style to a probe element, where a `fontSize` SVG attribute is
// never read and a unitless `12` is an invalid CSS value — so labels were measured at the document's
// default size, and "0.80 vCPU" broke onto two lines inside the axis gutter.
// The one sanctioned hex exception, as on the console: the chart axis, grid and series palette.
const AXIS_TICK = { fill: '#525252', style: { fontSize: '12px' } } as const
const GRID_STROKE = 'rgba(0,0,0,0.08)'

/** Merge a card's series into recharts rows keyed by timestamp: { t, <lineKey>: value }. */
function toRows(card: MetricCardData): Record<string, number>[] {
  const byT = new Map<number, Record<string, number>>()
  for (const line of card.lines) {
    for (const p of line.points) {
      const row = byT.get(p.t) ?? { t: p.t }
      row[line.key] = p.value
      byT.set(p.t, row)
    }
  }
  return [...byT.values()].sort((a, b) => a.t! - b.t!)
}

export function ChartTooltip({ active, label, card }: { active?: boolean; label?: number; card: MetricCardData }) {
  if (!active || label == null) return null
  return (
    <div className="min-w-40 rounded-md border border-border bg-card px-3 py-2 text-xs shadow-sm">
      <div className="mb-1.5 text-muted-foreground">{formatTimestamp(label)}</div>
      <div className="flex flex-col gap-1">
        {card.lines.map((line) => {
          const point = line.points.find((p) => p.t === label)
          return (
            <div key={line.key} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5">
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: line.color }} />
                {line.name}
              </span>
              <span className="font-medium tabular-nums">{point ? formatMetricValue(card, point.value) : '—'}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** `height` may be "100%" when the parent sizes the chart. */
export function TimeSeriesChart({ card, height }: { card: MetricCardData; height: number | '100%' }) {
  // Gradient ids must be unique per mounted chart — the same card can render on several views.
  // useId's colons are stripped: they're invalid inside SVG url(#…) references.
  const gradientId = useId().replace(/:/g, '')
  const rows = toRows(card)

  // An all-zero series (idle service, or a zero-filled placeholder) would collapse an "auto" upper
  // bound to [0, 0]; pin a real scale so the flat line reads as 0 usage on a normal axis.
  const hasSignal = card.lines.some((line) => line.points.some((p) => p.value > 0))
  const yMax: number | 'auto' = hasSignal ? 'auto' : card.kind === 'percent' ? 100 : 1

  // Label the round clock times inside the window rather than letting recharts subdivide it from
  // whatever second the first sample landed on. Undefined for a single point.
  const ticks = rows.length > 1 ? clockTicks(rows[0]!.t!, rows[rows.length - 1]!.t!) : undefined

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={rows} margin={{ top: 10, right: 8, bottom: 0, left: 0 }}>
        <defs>
          {card.lines.map((line) => (
            <linearGradient key={line.key} id={`${gradientId}-${line.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={line.color} stopOpacity={0.18} />
              <stop offset="100%" stopColor={line.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid vertical={false} stroke={GRID_STROKE} />
        <YAxis
          domain={[0, yMax]}
          axisLine={false}
          tickLine={false}
          // The gutter is also the label's wrap width, so it has to fit the longest label the
          // formatter can produce: a near-idle "0.000075 vCPU". 104px, not the console's 88: in this
          // dashboard's font the console's width clipped "0.00080 vCPU" to "00080 vCPU".
          width={104}
          tickMargin={8}
          tick={AXIS_TICK}
          tickFormatter={(v: number) => formatMetricValue(card, v)}
        />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          ticks={ticks}
          tickFormatter={formatClock}
          axisLine={false}
          tickLine={false}
          tickMargin={8}
          tick={AXIS_TICK}
        />
        <Tooltip content={<ChartTooltip card={card} />} cursor={{ stroke: '#525252', strokeWidth: 1, strokeDasharray: '3 3' }} />
        {card.lines.map((line) => (
          <Area
            key={line.key}
            type="linear"
            dataKey={line.key}
            stroke={line.color}
            strokeWidth={2}
            fill={`url(#${gradientId}-${line.key})`}
            dot={false}
            isAnimationActive={false}
            connectNulls
            activeDot={{ r: 3, fill: line.color, strokeWidth: 0 }}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  )
}
