// The console's metrics presentation (insta-frontend src/lib/api/metrics.ts), ported so the
// Observability page and a service's Metrics tab read the same as on the cloud: absolute vCPU and
// memory, one line per service, idle services drawn flat at zero, and the same value formatting and
// clock axis.
//
// Self-host divergences, each because of what the box does or does not measure:
// - No Disk card for databases. The daemon reports no disk series, and a flat zero invented for one
//   reads as "measured, and idle" — the lie the console itself refuses to tell for compute disks.
// - Redis, MySQL and MongoDB are components of their own (the daemon observes each), drawn on the CPU
//   and Memory cards beside compute and Postgres. The console knows only compute and Postgres.

import { obsComponentFor, type MetricSeries, type MetricsResult, type ObsComponent } from '../api'

/** How to format a series' values. */
export type MetricKind = 'percent' | 'bytes' | 'bytes-rate' | 'raw'

export interface MetricPoint {
  t: number
  value: number
}

/** One drawn line within a card (design supports several; real data is usually one). */
export interface MetricLine {
  key: string
  name: string
  color: string
  points: MetricPoint[]
}

export interface MetricCardData {
  id: string
  title: string
  kind: MetricKind
  unit: string
  /** One or more series drawn on this card, front-most first. */
  lines: MetricLine[]
  /**
   * Names what the headline and AVG/MAX/LATEST describe, for cards where that is narrower than the
   * card itself — `seriesStats` summarizes the front-most line only, so on Network Traffic an
   * unlabelled "2.0 KB/s" reads as the total of both directions. Set even when a single direction
   * arrived, since which one it is still isn't visible from the title.
   */
  summaryLabel?: string
}

/** Line colors (Figma). First three indices are FIXED — index 2 is ingress, and idle must recolor
 *  identically to active. The tail covers a project's five services per type. */
export const SERIES_COLORS = ['#059669', '#ec4899', '#3b82f6', '#f59e0b', '#8b5cf6', '#14b8a6'] as const

/** Per-service line color, stable across cards and wrapping if a project outgrows the palette. */
function serviceColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length]!
}

/** The service a series belongs to, as labelled by the daemon (and the platform's metrics fan-out). */
function groupOf(s: MetricSeries): string | undefined {
  const g = s.labels?.group
  return typeof g === 'string' && g.length > 0 ? g : undefined
}

/** Services to draw, in order. Caller's roster wins over the payload's labels: an undeployed service
 *  reports no series, so a payload-derived list omits exactly the idle ones worth showing. */
function serviceOrder(series: MetricSeries[], services?: string[]): string[] {
  if (services && services.length > 0) return services
  const seen: string[] = []
  for (const s of series) {
    const g = groupOf(s)
    if (g && !seen.includes(g)) seen.push(g)
  }
  return seen
}

/**
 * The combined egress + ingress card. Its id is its own rather than either series' name, because
 * the card exists whenever EITHER direction arrives — keying it to one series would make the card
 * identity depend on which half the platform happened to return.
 */
const NETWORK_CARD_ID = 'network_bytes_rate'
/** Ingress is the second line on that card; egress keeps the default first-series color. */
const INGRESS_COLOR = SERIES_COLORS[2]

/**
 * Known series. The daemon emits cpu_cores, memory_used_bytes, egress_bytes_rate and
 * ingress_bytes_rate — the cloud's names — so these presets are the console's own. Unknown series
 * still render as raw cards, so a new series appears without a dashboard change.
 */
const SERIES_PRESENTATION: Record<string, { title: string; kind: MetricKind; label: string }> = {
  cpu_pct: { title: 'CPU Usage', kind: 'percent', label: 'CPU' },
  // Absolute CPU (vCPU cores used) — autoscaling-safe, preferred over cpu_pct. `raw` renders the
  // value with its unit, e.g. "0.82 vCPU".
  cpu_cores: { title: 'CPU Usage', kind: 'raw', label: 'CPU' },
  // egress_bytes_rate / ingress_bytes_rate are deliberately absent: they share one card, built by
  // trafficCard() rather than one card per series.
  db_storage_bytes: { title: 'Disk Usage', kind: 'bytes', label: 'Disk' },
}

function toPoints(series: MetricSeries): MetricPoint[] {
  return (series.points ?? [])
    .filter((p) => Array.isArray(p) && p.length >= 2)
    .map(([t, value]) => ({ t: t!, value: value! }))
}

/** Service rosters split by metrics component. Storage is absent on purpose: it has no container, so
 *  it reports no series, and a zero-filled card for something never measured reads as "measured,
 *  and idle". */
export function serviceNamesByComponent(services: ReadonlyArray<{ type: string; name: string }>): Partial<Record<MetricComponent, string[]>> {
  const out: Partial<Record<MetricComponent, string[]>> = {}
  for (const s of services) {
    const component = obsComponentFor(s.type)
    if (component) (out[component] ??= []).push(s.name)
  }
  return out
}

/**
 * Map a MetricsResult into presentable cards. CPU prefers the absolute `cpu_cores`
 * (vCPU) series, falling back to `cpu_pct`; memory renders `memory_used_bytes` as
 * an absolute figure (GB/MB) — both autoscaling-safe, unlike a percentage. Every
 * other series becomes its own card. `lineName` labels each line with the service
 * the metrics belong to; without it lines fall back to the metric's own label.
 */
export function toMetricCards(result: MetricsResult | undefined, lineName?: string, services?: string[]): MetricCardData[] {
  const series = result?.series ?? []

  // 2+ services → one line each. Below that the single-service shape is unchanged.
  const order = serviceOrder(series, services)
  if (order.length > 1) return multiServiceCards(series, order)

  // Series carry their owner, so a caller with no `lineName` still gets a named line.
  const name = lineName ?? order[0]

  const byName = new Map<string, MetricSeries>()
  for (const s of series) if (s.name) byName.set(s.name, s)

  const cards: MetricCardData[] = []

  // CPU — prefer the absolute vCPU series; fall back to the percentage for a series set without it.
  const cpuCores = byName.get('cpu_cores')
  const cpuPct = byName.get('cpu_pct')
  if (cpuCores) cards.push(singleLineCard('cpu_cores', cpuCores, name))
  else if (cpuPct) cards.push(singleLineCard('cpu_pct', cpuPct, name))

  // Memory: absolute used bytes (autoscaling-safe; a used/total percentage moves with the ceiling).
  const memCard = memoryCard(byName.get('memory_used_bytes'), name)
  if (memCard) cards.push(memCard)

  // Network: egress and ingress share one card, so both directions read against the same axis.
  const netCard = trafficCard(byName.get('egress_bytes_rate'), byName.get('ingress_bytes_rate'))
  if (netCard) cards.push(netCard)

  // Everything else — unknown series render raw, so a new series appears without a change here.
  const consumed = new Set(CONSUMED_SERIES)
  for (const s of series) {
    if (!s.name || consumed.has(s.name)) continue
    cards.push(singleLineCard(s.name, s, name))
    consumed.add(s.name)
  }

  return cards
}

/** Series the named cards already draw, or deliberately do not (see the console's notes on each):
 *  the public egress/ingress subset is a subset of the totals, and http_req_rate is the series
 *  traffic replaced. */
const CONSUMED_SERIES = [
  'cpu_cores',
  'cpu_pct',
  'memory_used_bytes',
  'memory_total_bytes',
  'egress_bytes_rate',
  'ingress_bytes_rate',
  'public_egress_bytes_rate',
  'public_ingress_bytes_rate',
  'http_req_rate',
]

/** One card per metric, one line per service — the project-scoped shape. A service with no samples
 *  contributes no line here; withZeroUsageFill draws it flat at zero. */
function multiServiceCards(series: MetricSeries[], order: string[]): MetricCardData[] {
  const byGroup = new Map<string, Map<string, MetricSeries>>()
  for (const s of series) {
    const g = groupOf(s)
    if (!g || !s.name) continue
    if (!byGroup.has(g)) byGroup.set(g, new Map())
    byGroup.get(g)!.set(s.name, s)
  }
  const has = (metric: string) => order.some((g) => byGroup.get(g)?.has(metric))

  const card = (id: string, title: string, kind: MetricKind, metric: string, unit?: string): MetricCardData | null => {
    const lines: MetricLine[] = []
    order.forEach((g, i) => {
      const s = byGroup.get(g)?.get(metric)
      if (!s) return
      lines.push({ key: `${id}:${g}`, name: g, color: serviceColor(i), points: toPoints(s) })
    })
    if (lines.length === 0) return null
    const sample = order.map((g) => byGroup.get(g)?.get(metric)).find(Boolean)
    return { id, title, kind, unit: unit ?? sample?.unit ?? '', lines }
  }

  const cards: MetricCardData[] = []
  // CPU series chosen ONCE per card: mixing cpu_cores and cpu_pct puts 0.3 vCPU and 30% at one height.
  const cpu = has('cpu_cores')
    ? card('cpu_cores', 'CPU Usage', 'raw', 'cpu_cores')
    : card('cpu_pct', 'CPU Usage', 'percent', 'cpu_pct')
  if (cpu) cards.push(cpu)
  const mem = card('memory_used_bytes', 'Memory Usage', 'bytes', 'memory_used_bytes')
  if (mem) cards.push(mem)
  // Egress only: the one worth comparing across services. Ingress stays on service detail.
  const egress = card('egress_bytes_rate', 'Network Egress', 'bytes-rate', 'egress_bytes_rate', '')
  if (egress) cards.push(egress)

  // Unknown series pass through, one card each, so a new series needs no dashboard change.
  const consumed = new Set(CONSUMED_SERIES)
  for (const s of series) {
    if (!s.name || consumed.has(s.name)) continue
    // KIND from the preset too: hardcoding "raw" rendered disk as `1073741824`, not `1.0 GB`.
    const preset = SERIES_PRESENTATION[s.name]
    const extra = card(s.name, preset?.title ?? s.name, preset?.kind ?? 'raw', s.name)
    if (extra) cards.push(extra)
    consumed.add(s.name)
  }

  return cards
}

/** Which metrics source a view is reading — selects the always-present cards. */
export type MetricComponent = ObsComponent

/** How a component names itself when a service name has to be disambiguated. */
const COMPONENT_LABEL: Record<MetricComponent, string> = {
  compute: 'compute', db: 'postgres', redis: 'redis', mysql: 'mysql', mongodb: 'mongodb',
}

/** A component's services, as drawn. Kept split because only a component that measures a metric may
 *  have a flat line invented on that metric's card. */
export interface ServiceRoster {
  component: MetricComponent
  /** Display names, already disambiguated across components. */
  services: string[]
}

/** One metrics payload paired with the component and service roster it came from. */
export interface MetricSourceResult {
  /** Undefined means the request FAILED — not that it answered with nothing, which is `{ series: [] }`. */
  result?: { series?: MetricSeries[]; note?: string }
  component: MetricComponent
  services?: string[]
}

/** Merge components into one series set so databases draw beside compute on the same cards. Names are
 *  unique per TYPE only, so a name used by two components is suffixed with its component. `note`
 *  survives only when nothing at all is chartable.
 *
 *  A source whose request failed is left out entirely, its roster included. Keeping the roster made
 *  zero-fill draw every one of its services as a flat zero line, so a failed compute request beside a
 *  working database read as every app being idle: "unavailable" must never be drawn as "idle". */
export function mergeMetricSources(sources: Array<MetricSourceResult | undefined>): {
  series: MetricSeries[]
  roster: string[]
  /**
   * The same names, still split by component. Zero-fill needs the split: which services a card may
   * invent a flat line for depends on whether their component measures that metric at all.
   */
  rosters: ServiceRoster[]
  note?: string
} {
  const present = sources.filter((s): s is MetricSourceResult => s !== undefined && s.result !== undefined)
  const seenIn = new Map<string, number>()
  for (const s of present) {
    for (const name of s.services ?? []) seenIn.set(name, (seenIn.get(name) ?? 0) + 1)
  }
  const display = (name: string, component: MetricComponent) =>
    (seenIn.get(name) ?? 0) > 1 ? `${name} (${COMPONENT_LABEL[component]})` : name

  const roster: string[] = []
  const rosters: ServiceRoster[] = []
  const series: MetricSeries[] = []
  for (const s of present) {
    const shownNames: string[] = []
    for (const name of s.services ?? []) {
      const shown = display(name, s.component)
      shownNames.push(shown)
      if (!roster.includes(shown)) roster.push(shown)
    }
    rosters.push({ component: s.component, services: shownNames })
    for (const raw of s.result?.series ?? []) {
      const g = groupOf(raw)
      series.push(g ? { ...raw, labels: { ...raw.labels, group: display(g, s.component) } } : raw)
    }
  }
  return {
    series,
    roster,
    rosters,
    ...(series.length === 0 ? { note: present.map((s) => s.result?.note).find(Boolean) } : {}),
  }
}

/** The uniform time grid a zero-usage line is drawn over. */
export interface ZeroFillWindow {
  from: number
  to: number
  stepSeconds: number
}

/** A card that must always be present, and how to recognise the real one. */
interface ZeroFillSpec {
  id: string
  title: string
  kind: MetricKind
  unit?: string
  label: string
  /**
   * Lines drawn beside `label` on a multi-line card, so an idle card matches an active one
   * line-for-line. Their labels stay literal — two lines on one card can't both be named after
   * the service — and their colors must match the ones the real card is built with.
   */
  extraLines?: Array<{ label: string; color: string }>
  matches: (id: string) => boolean
}

// INVARIANT: `matches` MUST cover every id toMetricCards can emit for this card. CPU is emitted as
// either `cpu_cores` (absolute, preferred) or `cpu_pct` (fallback), so both must match — otherwise
// the real card falls through to the passthrough tail AND a zero placeholder is injected, rendering
// two "CPU Usage" cards. Zero-fill uses the absolute presentation (raw/vCPU) so an idle service reads
// `0 vCPU`, matching an active service's `0.82 vCPU` rather than a mismatched `0.0%`.
const CPU_SPEC: ZeroFillSpec = {
  id: 'cpu_cores',
  title: 'CPU Usage',
  kind: 'raw',
  unit: 'vCPU',
  label: 'CPU',
  matches: (id) => id === 'cpu_cores' || id === 'cpu_pct',
}

// Memory is emitted as absolute bytes (memory_used_bytes); match by prefix to also cover the legacy
// memory_pct id, and zero-fill as bytes so idle reads `0 B`, matching an active `1.2 GB`.
const MEMORY_SPEC: ZeroFillSpec = {
  id: 'memory_used_bytes',
  title: 'Memory Usage',
  kind: 'bytes',
  label: 'Memory',
  matches: (id) => id.startsWith('memory'),
}

// Both traffic directions, matching the card trafficCard() builds. One id suffices here (unlike CPU's
// two): trafficCard emits NETWORK_CARD_ID whichever direction it was given.
const TRAFFIC_SPEC: ZeroFillSpec = {
  id: NETWORK_CARD_ID,
  title: 'Network Traffic',
  kind: 'bytes-rate',
  label: 'Egress',
  extraLines: [{ label: 'Ingress', color: INGRESS_COLOR }],
  matches: (id) => id === NETWORK_CARD_ID,
}

/** Egress alone on a project-scoped card; the single-service view uses TRAFFIC_SPEC's combined one. */
const EGRESS_SPEC: ZeroFillSpec = {
  id: 'egress_bytes_rate',
  title: 'Network Egress',
  kind: 'bytes-rate',
  unit: '',
  label: 'Egress',
  matches: (id) => id === 'egress_bytes_rate',
}

/** Always-present cards per component. Databases get CPU and Memory only: the box has no disk series
 *  (see the header), and traffic is invented only for compute so an IDLE database gets none — a
 *  database that reports traffic still draws its real line. */
const ZERO_FILL_CARDS: Record<MetricComponent, ZeroFillSpec[]> = {
  compute: [CPU_SPEC, MEMORY_SPEC, TRAFFIC_SPEC],
  db: [CPU_SPEC, MEMORY_SPEC],
  redis: [CPU_SPEC, MEMORY_SPEC],
  mysql: [CPU_SPEC, MEMORY_SPEC],
  mongodb: [CPU_SPEC, MEMORY_SPEC],
}

/** The component's cards with NO lines, for a view with nothing to measure (the daemon's `note`): the console draws
 *  its empty charts there, axes and "—", rather than a blank panel. No line, not a zero line: a zero would claim a
 *  reading of an idle service that does not exist. */
export function emptyMetricCards(component: MetricComponent): MetricCardData[] {
  return ZERO_FILL_CARDS[component].map((spec) => ({
    id: spec.id, title: spec.title, kind: spec.kind, unit: spec.unit ?? '', lines: [],
  }))
}

/**
 * Ensure a component's known cards always render: cards the daemon returned
 * pass through, missing ones become a flat zero line across the query window. An
 * idle or asleep service has no samples, and "no data" should read as 0
 * usage, not as a missing chart. Callers must NOT zero-fill when the result
 * carries a `note` — that's the daemon saying the metrics source itself isn't
 * available. Unknown series pass through untouched, after the known ones.
 */
export function withZeroUsageFill(
  cards: MetricCardData[],
  win: ZeroFillWindow,
  lineName?: string,
  component: MetricComponent = 'compute',
  rosters?: ServiceRoster[],
): MetricCardData[] {
  const points: MetricPoint[] = []
  for (let t = win.from; t <= win.to; t += win.stepSeconds) points.push({ t, value: 0 })

  // Multi-service fills per SERVICE: an undeployed one reports nothing, and its absence is the point.
  if (rosters && rosters.reduce((n, r) => n + r.services.length, 0) > 1) {
    return withMultiServiceFill(cards, points, rosters)
  }

  // One service: its OWN component picks the cards and names the lines. The view's primary component
  // said nothing about a lone database, and using it invented an all-zero Network Traffic card for a
  // series the daemon does not measure there, with lines called "CPU" rather than the service.
  const lone = rosters?.find((r) => r.services.length > 0)
  const specs = ZERO_FILL_CARDS[lone?.component ?? component]
  const name = lineName ?? lone?.services[0]
  const zero = (spec: ZeroFillSpec): MetricCardData => ({
    id: spec.id,
    title: spec.title,
    kind: spec.kind,
    unit: spec.unit ?? '',
    summaryLabel: spec.extraLines ? spec.label : undefined,
    lines: [
      // A single-line card is named after the service it belongs to; a multi-line card names its
      // own directions instead, or the two lines would be indistinguishable.
      { key: spec.id, name: spec.extraLines ? spec.label : (name ?? spec.label), color: SERIES_COLORS[0], points },
      ...(spec.extraLines ?? []).map((l) => ({ key: `${spec.id}:${l.label.toLowerCase()}`, name: l.label, color: l.color, points })),
    ],
  })
  return [
    ...specs.map((spec) => cards.find((c) => spec.matches(c.id)) ?? zero(spec)),
    ...cards.filter((c) => !specs.some((spec) => spec.matches(c.id))),
  ]
}

/** Same specs, grouped by which component may have a zero line invented on each card. Says nothing
 *  about reported data. Egress replaces the combined traffic card: one line per service per
 *  direction needs a legend nobody can read. */
const MULTI_FILL_CARDS: Record<MetricComponent, ZeroFillSpec[]> = {
  compute: [CPU_SPEC, MEMORY_SPEC, EGRESS_SPEC],
  db: [CPU_SPEC, MEMORY_SPEC],
  redis: [CPU_SPEC, MEMORY_SPEC],
  mysql: [CPU_SPEC, MEMORY_SPEC],
  mongodb: [CPU_SPEC, MEMORY_SPEC],
}

/** Every card gets its services' lines in one shared order. Reported lines always survive; a flat zero
 *  is invented ONLY where the component measures that metric — else a database lands on Egress. */
function withMultiServiceFill(cards: MetricCardData[], points: MetricPoint[], rosters: ServiceRoster[]): MetricCardData[] {
  const order = rosters.flatMap((r) => r.services)
  // A card may invent zero lines only for services whose component declares it.
  const eligibleFor = (spec: ZeroFillSpec) =>
    new Set(rosters.filter((r) => MULTI_FILL_CARDS[r.component].some((s) => s.id === spec.id)).flatMap((r) => r.services))

  const fill = (card: MetricCardData, eligible: Set<string>): MetricCardData => ({
    ...card,
    lines: order.flatMap((g, i) => {
      const drawn = card.lines.find((l) => l.name === g)
      if (drawn) return [drawn]
      if (!eligible.has(g)) return []
      return [{ key: `${card.id}:${g}`, name: g, color: serviceColor(i), points }]
    }),
  })

  // Deduped by id: CPU and Memory are declared by every component, and must not render twice.
  const specs: ZeroFillSpec[] = []
  for (const r of rosters) {
    for (const spec of MULTI_FILL_CARDS[r.component]) {
      if (!specs.some((s) => s.id === spec.id)) specs.push(spec)
    }
  }
  return [
    ...specs.map((spec) =>
      fill(cards.find((c) => spec.matches(c.id)) ?? { id: spec.id, title: spec.title, kind: spec.kind, unit: spec.unit ?? '', lines: [] }, eligibleFor(spec)),
    ),
    ...cards.filter((c) => !specs.some((spec) => spec.matches(c.id))).map((c) => fill(c, new Set(order))),
  ]
}

/** What a view renders for a set of sources: merged cards, whether lines are services, and the note
 *  that replaces the charts. Zero-fill is skipped ONLY for a note — an empty series set is exactly
 *  what it exists for, and gating on it blanked the page. */
export function cardsForSources(
  sources: Array<MetricSourceResult | undefined>,
  win: ZeroFillWindow,
  lineName?: string,
  component: MetricComponent = 'compute',
): { cards: MetricCardData[]; note?: string; byService: boolean } {
  const merged = mergeMetricSources(sources)
  const cards = toMetricCards({ source: 'merged', series: merged.series }, lineName, merged.roster)
  const byService = merged.roster.length > 0
  if (merged.note) return { cards, note: merged.note, byService }
  return { cards: withZeroUsageFill(cards, win, lineName, component, merged.rosters), byService }
}

function singleLineCard(id: string, series: MetricSeries, lineName?: string): MetricCardData {
  const preset = SERIES_PRESENTATION[id]
  return {
    id,
    title: preset?.title ?? id,
    kind: preset?.kind ?? 'raw',
    unit: series.unit ?? '',
    lines: [{ key: id, name: lineName ?? preset?.label ?? id, color: SERIES_COLORS[0], points: toPoints(series) }],
  }
}

function memoryCard(used: MetricSeries | undefined, lineName?: string): MetricCardData | null {
  if (!used) return null
  const usedPoints = toPoints(used)
  if (usedPoints.length === 0) return null

  // Absolute memory used (bytes → formatted GB/MB). A used/total percentage is ambiguous under
  // autoscaling (the total moves), so we show the absolute figure — the honest resident memory.
  return {
    id: 'memory_used_bytes',
    title: 'Memory Usage',
    kind: 'bytes',
    unit: used.unit ?? 'bytes',
    lines: [{ key: 'memory', name: lineName ?? 'Memory', color: SERIES_COLORS[0], points: usedPoints }],
  }
}

/**
 * Egress and ingress on one card, egress front-most — a customer reading traffic needs both
 * directions against a shared axis; an upload-heavy service looks idle on egress alone. Returns null
 * when neither direction was reported, so nothing invents a flat line for something never measured.
 */
function trafficCard(egress: MetricSeries | undefined, ingress: MetricSeries | undefined): MetricCardData | null {
  const lines: MetricLine[] = []
  if (egress) lines.push({ key: 'egress', name: 'Egress', color: SERIES_COLORS[0], points: toPoints(egress) })
  if (ingress) lines.push({ key: 'ingress', name: 'Ingress', color: INGRESS_COLOR, points: toPoints(ingress) })
  if (lines.length === 0) return null
  return {
    id: NETWORK_CARD_ID,
    title: 'Network Traffic',
    kind: 'bytes-rate',
    unit: '',
    lines,
    summaryLabel: lines[0]!.name,
  }
}

export interface SeriesStats {
  avg: string
  max: string
  latest: string
}

/** AVG / MAX / LATEST for a card's primary (front-most) series. */
export function seriesStats(card: MetricCardData): SeriesStats {
  const values = (card.lines[0]?.points ?? []).map((p) => p.value)
  if (values.length === 0) return { avg: '—', max: '—', latest: '—' }
  const avg = values.reduce((a, b) => a + b, 0) / values.length
  const max = Math.max(...values)
  const latest = values[values.length - 1]!
  return { avg: formatMetricValue(card, avg), max: formatMetricValue(card, max), latest: formatMetricValue(card, latest) }
}

// A significance floor for fixed-decimal renderings. An idle service's REAL cpu_cores reading is
// ~0.0004 vCPU; `toFixed(2)` renders that as "0.00 vCPU" on the axis, the tooltip, AND the card's
// current value — which reads as "metrics not created", not as "very small". Non-zero values below
// the fixed rendering's resolution switch to two significant digits so the magnitude survives. True
// zero keeps the fixed rendering: a stopped container's flat zero is information, not a formatting
// casualty.
function fixedOrSignificant(v: number, fixed: (n: number) => string, resolution: number): string {
  if (v !== 0 && Number.isFinite(v) && Math.abs(v) < resolution) return v.toPrecision(2)
  return fixed(v)
}

export function formatMetricValue(card: Pick<MetricCardData, 'kind' | 'unit'>, v: number): string {
  switch (card.kind) {
    case 'percent':
      return `${fixedOrSignificant(v, (n) => n.toFixed(1), 0.1)}%`
    case 'bytes':
      return formatBytes(v)
    case 'bytes-rate':
      // Network traffic is scaled by 1000, not 1024, as on the console, where egress is billed in
      // decimal GB. Memory and disk stay binary above: those ceilings are provisioned in GiB.
      return `${formatBytes(v, 1000)}/s`
    default:
      // Significant digits below 0.1: two decimals rendered a real 0.028 vCPU tick as "0.03".
      return `${fixedOrSignificant(v, (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2)), 0.1)}${card.unit ? ` ${card.unit}` : ''}`
  }
}

function formatBytes(v: number, base: 1000 | 1024 = 1024): string {
  if (!Number.isFinite(v)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = v
  let i = 0
  while (value >= base && i < units.length - 1) {
    value /= base
    i += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`
}

/** Unix seconds → "HH:MM" in the viewer's local timezone, as the console's charts label time. */
export function formatClock(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The viewer's zone abbreviation for a given instant — "PDT" where one exists,
 * "GMT+5:30"-style otherwise. Per-instant because the abbreviation follows DST
 * (PDT vs PST). en-US is pinned so the axis's own labels don't vary by locale;
 * the ZONE still follows the viewer.
 */
function localZoneAbbr(d: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d).find((part) => part.type === 'timeZoneName')?.value ?? ''
}

/**
 * Unix seconds → "Jul 14, 18:30 PDT" (viewer-local) for chart tooltips. The
 * zone marker rides the hover only — axis ticks stay bare — so a reported
 * spike time says which clock it's on without cluttering the chart.
 */
export function formatTimestamp(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  const zone = localZoneAbbr(d)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${formatClock(unixSeconds)}${zone ? ` ${zone}` : ''}`
}

/**
 * Tick intervals a reader recognises as round on a clock, finest first. Each one
 * divides a day, so a whole number of them from a local midnight always lands on
 * a round time in the zone the axis is labelled in.
 */
const CLOCK_TICK_INTERVALS = [60, 120, 300, 600, 900, 1_800, 3_600, 7_200, 10_800, 21_600, 43_200, 86_400] as const

/** Tick budget — enough to read the span, few enough to fit a chart in a narrow column. */
const MAX_CLOCK_TICKS = 6

/**
 * X-axis ticks on round clock times — every 5 or 15 minutes, every hour, and so
 * on — for the window [from, to] in unix seconds. Left to itself recharts
 * divides the window evenly from whatever second it began at, producing labels
 * no one can locate on a clock. The coarsest-fitting interval is chosen so the
 * window carries no more than `maxTicks` gaps. Alignment follows the viewer's
 * local zone, which formatClock labels; the offset is taken at `to`, so a DST
 * change inside the window shifts alignment by an hour on the far side, which is
 * acceptable for a metrics axis.
 */
export function clockTicks(from: number, to: number, maxTicks = MAX_CLOCK_TICKS): number[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return []
  const span = to - from
  const step = CLOCK_TICK_INTERVALS.find((interval) => span / interval <= maxTicks) ?? CLOCK_TICK_INTERVALS[CLOCK_TICK_INTERVALS.length - 1]!

  const offset = -new Date(to * 1000).getTimezoneOffset() * 60
  const ticks: number[] = []
  for (let t = Math.ceil((from + offset) / step) * step - offset; t <= to; t += step) ticks.push(t)
  return ticks
}
