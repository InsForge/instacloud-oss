// Ported from insta-frontend src/lib/api/metrics.test.ts, so the dashboard's cards stay pinned to the
// console's behavior. Changes from the original are the self-host divergences in metrics.ts: no Disk
// card for databases, and Redis / MySQL / MongoDB as components.

import { afterEach, describe, expect, it } from 'vitest'
import {
  clockTicks,
  formatClock,
  formatMetricValue,
  cardsForSources,
  formatTimestamp,
  mergeMetricSources,
  serviceNamesByComponent,
  toMetricCards,
  withZeroUsageFill,
} from './metrics'

type MetricsResult = Parameters<typeof toMetricCards>[0]

const WIN = { from: 0, to: 120, stepSeconds: 60 }
const series = (name: string, unit: string, value: number) => ({
  name,
  unit,
  points: [[0, value], [60, value], [120, value]] as [number, number][],
})
const result = (...s: ReturnType<typeof series>[]): MetricsResult => ({ source: 'docker-stats', series: s }) as MetricsResult

/** A series as the daemon's fan-out sends it: tagged with its owning service. */
const owned = (group: string, name: string, unit: string, value: number) => ({ ...series(name, unit, value), labels: { group } })

describe('toMetricCards — absolute CPU and memory', () => {
  it('prefers the absolute cpu_cores series over cpu_pct', () => {
    const res = result(series('cpu_cores', 'vCPU', 0.82), series('cpu_pct', 'percent', 41))
    const cpu = toMetricCards(res).filter((c) => c.title === 'CPU Usage')
    expect(cpu).toHaveLength(1)
    expect(cpu[0]!.id).toBe('cpu_cores')
  })

  it('falls back to cpu_pct when cpu_cores is absent', () => {
    const cpu = toMetricCards(result(series('cpu_pct', 'percent', 41))).filter((c) => c.title === 'CPU Usage')
    expect(cpu).toHaveLength(1)
    expect(cpu[0]!.id).toBe('cpu_pct')
  })

  it('renders memory as absolute bytes, not a percentage', () => {
    const mem = toMetricCards(result(series('memory_used_bytes', 'bytes', 1.2e9), series('memory_total_bytes', 'bytes', 2e9)))
      .find((c) => c.title === 'Memory Usage')
    expect(mem?.id).toBe('memory_used_bytes')
    expect(mem?.kind).toBe('bytes')
  })
})

describe('withZeroUsageFill — no duplicate/fabricated CPU card', () => {
  it('passes the real cpu_cores card through without injecting a zero placeholder', () => {
    const filled = withZeroUsageFill(toMetricCards(result(series('cpu_cores', 'vCPU', 0.82))), WIN, 'web', 'compute')
    const cpu = filled.filter((c) => c.title === 'CPU Usage')
    expect(cpu).toHaveLength(1)
    expect(cpu[0]!.id).toBe('cpu_cores')
    expect(cpu[0]!.lines[0]!.points.some((p) => p.value > 0)).toBe(true)
  })

  it("zero-fills an idle service's CPU as absolute vCPU (matches the active presentation)", () => {
    const cpu = withZeroUsageFill([], WIN, 'web', 'compute').find((c) => c.title === 'CPU Usage')
    expect(cpu?.id).toBe('cpu_cores')
    expect(cpu?.kind).toBe('raw')
    expect(cpu?.unit).toBe('vCPU')
  })

  it('still recognizes the cpu_pct fallback so no duplicate appears', () => {
    const filled = withZeroUsageFill(toMetricCards(result(series('cpu_pct', 'percent', 41))), WIN, 'web', 'compute')
    expect(filled.filter((c) => c.title === 'CPU Usage')).toHaveLength(1)
  })

  it('zero-fills idle memory as absolute bytes', () => {
    expect(withZeroUsageFill([], WIN, 'web', 'compute').find((c) => c.title === 'Memory Usage')?.kind).toBe('bytes')
  })
})

describe('network traffic card', () => {
  const traffic = (cards: ReturnType<typeof toMetricCards>) => cards.find((c) => c.title === 'Network Traffic')

  it('draws egress and ingress as two lines on one card', () => {
    const card = traffic(toMetricCards(result(series('egress_bytes_rate', 'bytes/s', 2048), series('ingress_bytes_rate', 'bytes/s', 512))))
    expect(card?.kind).toBe('bytes-rate')
    expect(card?.lines.map((l) => l.name)).toEqual(['Egress', 'Ingress'])
    expect(card!.lines[0]!.color).not.toBe(card!.lines[1]!.color)
    expect(card?.summaryLabel).toBe('Egress')
  })

  it('renders a single direction when only one arrives, and says which', () => {
    const egressOnly = traffic(toMetricCards(result(series('egress_bytes_rate', 'bytes/s', 2048))))
    expect(egressOnly?.lines.map((l) => l.name)).toEqual(['Egress'])
    expect(egressOnly?.summaryLabel).toBe('Egress')
    const ingressOnly = traffic(toMetricCards(result(series('ingress_bytes_rate', 'bytes/s', 512))))
    expect(ingressOnly?.lines.map((l) => l.name)).toEqual(['Ingress'])
    expect(ingressOnly?.summaryLabel).toBe('Ingress')
  })

  it('zero-fills an idle compute service with both directions flat at 0, in the active colors', () => {
    const card = traffic(withZeroUsageFill([], WIN, 'web', 'compute'))
    expect(card?.lines.map((l) => l.name)).toEqual(['Egress', 'Ingress'])
    expect(card?.lines.every((l) => l.points.every((p) => p.value === 0))).toBe(true)
    const active = traffic(toMetricCards(result(series('egress_bytes_rate', 'bytes/s', 2048), series('ingress_bytes_rate', 'bytes/s', 512))))
    expect(card?.lines.map((l) => l.color)).toEqual(active?.lines.map((l) => l.color))
  })

  it('passes the real card through instead of adding a zero placeholder', () => {
    const filled = withZeroUsageFill(toMetricCards(result(series('egress_bytes_rate', 'bytes/s', 2048))), WIN, 'web', 'compute')
    expect(filled.filter((c) => c.title === 'Network Traffic')).toHaveLength(1)
    expect(traffic(filled)!.lines[0]!.points.some((p) => p.value > 0)).toBe(true)
  })

  it('invents no traffic card for an idle database', () => {
    expect(traffic(withZeroUsageFill([], WIN, 'pg', 'db'))).toBeUndefined()
  })

  it('drops the replaced http_req_rate series', () => {
    const filled = withZeroUsageFill(toMetricCards(result(series('http_req_rate', 'req/s', 3))), WIN, 'web', 'compute')
    expect(filled.map((c) => c.title)).toEqual(['CPU Usage', 'Memory Usage', 'Network Traffic'])
  })

  it('formats a byte rate per second, scaled by 1000', () => {
    expect(formatMetricValue({ kind: 'bytes-rate', unit: '' }, 2048)).toBe('2.0 KB/s')
    expect(formatMetricValue({ kind: 'bytes-rate', unit: '' }, 0)).toBe('0.0 B/s')
    expect(formatMetricValue({ kind: 'bytes-rate', unit: '' }, 1000)).toBe('1.0 KB/s')
    expect(formatMetricValue({ kind: 'bytes-rate', unit: '' }, 1e9)).toBe('1.0 GB/s')
    expect(formatMetricValue({ kind: 'bytes', unit: 'bytes' }, 1024 ** 3)).toBe('1.0 GB')
    expect(formatMetricValue({ kind: 'bytes', unit: 'bytes' }, 1000)).toBe('1000 B')
  })

  it("keeps tiny non-zero readings visible instead of flooring them to 0.00 (reads as 'metrics not created')", () => {
    expect(formatMetricValue({ kind: 'raw', unit: 'vCPU' }, 0.0004449)).toBe('0.00044 vCPU')
    expect(formatMetricValue({ kind: 'percent', unit: '' }, 0.0449)).toBe('0.045%')
    expect(formatMetricValue({ kind: 'raw', unit: 'vCPU' }, 0.82)).toBe('0.82 vCPU')
    expect(formatMetricValue({ kind: 'raw', unit: 'vCPU' }, 2)).toBe('2 vCPU')
    expect(formatMetricValue({ kind: 'percent', unit: '' }, 41)).toBe('41.0%')
    expect(formatMetricValue({ kind: 'raw', unit: 'vCPU' }, 0)).toBe('0 vCPU')
    expect(formatMetricValue({ kind: 'percent', unit: '' }, 0)).toBe('0.0%')
  })

  it('does not draw the public subset as its own raw cards', () => {
    const cards = toMetricCards(result(
      series('egress_bytes_rate', 'bytes/s', 2048),
      series('ingress_bytes_rate', 'bytes/s', 512),
      series('public_egress_bytes_rate', 'bytes/s', 1024),
      series('public_ingress_bytes_rate', 'bytes/s', 256),
    ))
    expect(cards.map((c) => c.title)).toEqual(['Network Traffic'])
  })
})

const TZ = process.env.TZ
afterEach(() => { process.env.TZ = TZ })

/** Unix seconds for a wall-clock time written with its own offset. */
const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)

describe("chart clock labels follow the viewer's zone", () => {
  it('labels the axis and tooltip in local time whatever zone the viewer is in', () => {
    process.env.TZ = 'America/Los_Angeles'
    const t = at('2026-08-10T18:38:00Z')
    expect(formatClock(t)).toBe('11:38')
    expect(formatTimestamp(t)).toBe('Aug 10, 11:38 PDT')
    process.env.TZ = 'Asia/Kolkata'
    expect(formatClock(t)).toBe('00:08')
    expect(formatTimestamp(t)).toBe('Aug 11, 00:08 GMT+5:30')
  })

  it('names the zone by the hovered instant, so DST flips the abbreviation', () => {
    process.env.TZ = 'America/Los_Angeles'
    expect(formatTimestamp(at('2026-08-10T18:38:00Z'))).toContain('PDT')
    expect(formatTimestamp(at('2026-01-10T18:38:00Z'))).toContain('PST')
  })
})

describe('clockTicks — round clock labels', () => {
  const expectAligned = (ticks: number[], step: number, from: number, to: number) => {
    expect(ticks.length).toBeGreaterThan(1)
    for (const t of ticks) {
      const d = new Date(t * 1000)
      expect(d.getSeconds()).toBe(0)
      if (step < 3_600) expect(d.getMinutes() % (step / 60)).toBe(0)
      else {
        expect(d.getMinutes()).toBe(0)
        expect(d.getHours() % (step / 3_600)).toBe(0)
      }
      expect(t).toBeGreaterThanOrEqual(from)
      expect(t).toBeLessThanOrEqual(to)
    }
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]! - ticks[i - 1]!).toBe(step)
  }

  it('labels a 1h window every 10 minutes, whatever second it started on', () => {
    process.env.TZ = 'UTC'
    const to = at('2026-08-10T18:43:00Z')
    expectAligned(clockTicks(to - 3_600, to), 600, to - 3_600, to)
    expect(clockTicks(to - 3_600, to).map(formatClock)).toEqual(['17:50', '18:00', '18:10', '18:20', '18:30', '18:40'])
  })

  it('labels 6h on the hour and 24h every 6 hours', () => {
    process.env.TZ = 'UTC'
    const to = at('2026-08-10T18:43:00Z')
    expectAligned(clockTicks(to - 21_600, to), 3_600, to - 21_600, to)
    expectAligned(clockTicks(to - 86_400, to), 21_600, to - 86_400, to)
  })

  it('keeps the tick count inside the budget so a narrow chart stays readable', () => {
    const to = at('2026-08-10T18:43:00Z')
    for (const span of [600, 3_600, 21_600, 86_400, 259_200]) expect(clockTicks(to - span, to).length).toBeLessThanOrEqual(7)
  })

  it('has no ticks for an empty, backwards or unmeasured window', () => {
    expect(clockTicks(1_000, 1_000)).toEqual([])
    expect(clockTicks(2_000, 1_000)).toEqual([])
    expect(clockTicks(Number.NaN, 1_000)).toEqual([])
  })
})

describe('multi-service environment view', () => {
  const ALL = ['app', 'test', 'test-ob']
  const COMPUTE_ROSTER = [{ component: 'compute' as const, services: ALL }]
  const card = (cards: ReturnType<typeof toMetricCards>, title: string) => cards.find((c) => c.title === title)

  it('draws one line per service, each named after its own service, in distinct colors', () => {
    const cpu = card(toMetricCards(result(
      owned('app', 'cpu_cores', 'vCPU', 0.1), owned('test', 'cpu_cores', 'vCPU', 0.2), owned('test-ob', 'cpu_cores', 'vCPU', 0.3),
    ), undefined, ALL), 'CPU Usage')
    expect(cpu?.lines.map((l) => l.name)).toEqual(ALL)
    expect(new Set(cpu!.lines.map((l) => l.color)).size).toBe(3)
  })

  it('zero-fills a service that reported nothing, so it reads as 0 rather than vanishing', () => {
    const filled = withZeroUsageFill(toMetricCards(result(owned('test-ob', 'cpu_cores', 'vCPU', 0.3)), undefined, ALL), WIN, undefined, 'compute', COMPUTE_ROSTER)
    const cpu = card(filled, 'CPU Usage')
    expect(cpu?.lines.map((l) => l.name)).toEqual(ALL)
    const idle = cpu!.lines.filter((l) => l.name !== 'test-ob')
    expect(idle.every((l) => l.points.length > 0 && l.points.every((p) => p.value === 0))).toBe(true)
  })

  it('gives a service the same color on every card, so the legend reads across them', () => {
    const filled = withZeroUsageFill(toMetricCards(result(
      owned('app', 'cpu_cores', 'vCPU', 0.1), owned('app', 'memory_used_bytes', 'bytes', 1e8),
      owned('test-ob', 'cpu_cores', 'vCPU', 0.3), owned('test-ob', 'memory_used_bytes', 'bytes', 2e8),
    ), undefined, ['app', 'test-ob']), WIN, undefined, 'compute', [{ component: 'compute' as const, services: ['app', 'test-ob'] }])
    const colorOn = (title: string, service: string) => card(filled, title)!.lines.find((l) => l.name === service)!.color
    expect(colorOn('CPU Usage', 'app')).toBe(colorOn('Memory Usage', 'app'))
    expect(colorOn('CPU Usage', 'test-ob')).toBe(colorOn('Memory Usage', 'test-ob'))
  })

  it('splits egress into its own card, one line per service', () => {
    const cards = toMetricCards(result(
      owned('app', 'egress_bytes_rate', 'bytes/s', 2048), owned('app', 'ingress_bytes_rate', 'bytes/s', 512),
      owned('test-ob', 'egress_bytes_rate', 'bytes/s', 4096), owned('test-ob', 'ingress_bytes_rate', 'bytes/s', 1024),
    ), undefined, ['app', 'test-ob'])
    expect(card(cards, 'Network Traffic')).toBeUndefined()
    expect(card(cards, 'Network Egress')?.lines.map((l) => l.name)).toEqual(['app', 'test-ob'])
    expect(card(cards, 'Network Ingress')).toBeUndefined()
  })

  it('renders every expected card even when no service reported anything at all', () => {
    const filled = withZeroUsageFill([], WIN, undefined, 'compute', COMPUTE_ROSTER)
    expect(filled.map((c) => c.title)).toEqual(['CPU Usage', 'Memory Usage', 'Network Egress'])
    expect(filled.every((c) => c.lines.map((l) => l.name).join() === ALL.join())).toBe(true)
  })

  it('leaves a one-service project on its original single-line shape', () => {
    const cards = toMetricCards(result(
      owned('only', 'cpu_cores', 'vCPU', 0.5), owned('only', 'egress_bytes_rate', 'bytes/s', 2048), owned('only', 'ingress_bytes_rate', 'bytes/s', 512),
    ), undefined, ['only'])
    expect(card(cards, 'Network Traffic')?.lines.map((l) => l.name)).toEqual(['Egress', 'Ingress'])
    expect(card(cards, 'CPU Usage')?.lines.map((l) => l.name)).toEqual(['only'])
  })
})

describe('mergeMetricSources — compute and databases on the same cards', () => {
  it('disambiguates a name carried by two different component types', () => {
    const merged = mergeMetricSources([
      { result: { series: [owned('postgres', 'cpu_cores', 'vCPU', 0.1)] }, component: 'compute', services: ['postgres', 'app'] },
      { result: { series: [owned('postgres', 'cpu_cores', 'vCPU', 0.2)] }, component: 'db', services: ['postgres'] },
    ])
    expect(merged.roster).toEqual(['postgres (compute)', 'app', 'postgres (postgres)'])
  })

  it('names a Redis service colliding with a compute one by its own type', () => {
    const merged = mergeMetricSources([
      { result: { series: [] }, component: 'compute', services: ['cache'] },
      { result: { series: [] }, component: 'redis', services: ['cache'] },
    ])
    expect(merged.roster).toEqual(['cache (compute)', 'cache (redis)'])
  })

  it("drops a source's note when another source has chartable data, and keeps it when nothing does", () => {
    expect(mergeMetricSources([
      { result: { series: [owned('app', 'cpu_cores', 'vCPU', 0.1)] }, component: 'compute', services: ['app'] },
      { result: { series: [], note: 'nothing deployed on this branch' }, component: 'db', services: ['db'] },
    ]).note).toBeUndefined()
    expect(mergeMetricSources([
      { result: { series: [], note: 'nothing deployed on this branch' }, component: 'compute', services: [] },
    ]).note).toMatch(/nothing deployed/)
  })

  it('puts a database on the same card as the compute services, idle ones flat at zero', () => {
    const merged = mergeMetricSources([
      { result: { series: [owned('app', 'cpu_cores', 'vCPU', 0.1)] }, component: 'compute', services: ['app', 'worker'] },
      { result: { series: [owned('db', 'cpu_cores', 'vCPU', 0.2)] }, component: 'db', services: ['db'] },
    ])
    const filled = withZeroUsageFill(toMetricCards({ source: 'merged', series: merged.series }, undefined, merged.roster), WIN, undefined, 'compute', merged.rosters)
    const cpu = filled.find((c) => c.title === 'CPU Usage')
    expect(cpu?.lines.map((l) => l.name)).toEqual(['app', 'worker', 'db'])
    expect(cpu!.lines.find((l) => l.name === 'worker')!.points.every((p) => p.value === 0)).toBe(true)
  })
})

describe('self-host divergences', () => {
  const filledFor = (sources: Parameters<typeof mergeMetricSources>[0]) => cardsForSources(sources, WIN, undefined, 'compute').cards

  // The box reports no disk series; a flat zero invented on a Disk card would read as measured and idle.
  it('invents no Disk card for a database, alone or beside compute', () => {
    expect(withZeroUsageFill([], WIN, 'db', 'db').map((c) => c.title)).toEqual(['CPU Usage', 'Memory Usage'])
    expect(filledFor([
      { result: { series: [] }, component: 'compute', services: ['app'] },
      { result: { series: [] }, component: 'db', services: ['db'] },
    ]).map((c) => c.title)).toEqual(['CPU Usage', 'Memory Usage', 'Network Egress'])
  })

  // Egress is invented only for compute, but a database's REAL traffic still draws.
  it("invents no egress line for an idle database, and keeps a reporting database's real one", () => {
    const idle = filledFor([
      { result: { series: [] }, component: 'compute', services: ['app'] },
      { result: { series: [] }, component: 'redis', services: ['cache'] },
    ]).find((c) => c.title === 'Network Egress')
    expect(idle?.lines.map((l) => l.name)).toEqual(['app'])
    const reporting = filledFor([
      { result: { series: [] }, component: 'compute', services: ['app'] },
      { result: { series: [owned('cache', 'egress_bytes_rate', 'bytes/s', 4096)] }, component: 'redis', services: ['cache'] },
    ]).find((c) => c.title === 'Network Egress')
    expect(reporting?.lines.map((l) => l.name)).toEqual(['app', 'cache'])
  })

  it('draws Redis, MySQL and MongoDB on the CPU and Memory cards beside Postgres', () => {
    const cards = filledFor([
      { result: { series: [] }, component: 'db', services: ['store'] },
      { result: { series: [] }, component: 'redis', services: ['cache'] },
      { result: { series: [] }, component: 'mysql', services: ['legacy'] },
      { result: { series: [] }, component: 'mongodb', services: ['docs'] },
    ])
    expect(cards.map((c) => c.title)).toEqual(['CPU Usage', 'Memory Usage'])
    expect(cards.every((c) => c.lines.map((l) => l.name).join() === 'store,cache,legacy,docs')).toBe(true)
  })

  it('splits a services list into rosters by metrics component, leaving storage out', () => {
    expect(serviceNamesByComponent([
      { type: 'compute', name: 'app' },
      { type: 'postgres', name: 'store' },
      { type: 'redis', name: 'cache' },
      { type: 'storage', name: 'files' },
      { type: 'compute', name: 'web' },
    ])).toEqual({ compute: ['app', 'web'], db: ['store'], redis: ['cache'] })
  })
})

describe('a failed source (regression: unavailable drawn as idle)', () => {
  // A failed compute request beside a working database used to keep compute's roster, and zero-fill
  // then drew every compute service as a flat zero: idle, when the truth was unknown.
  it('draws no zero line for the services of a source whose request failed', () => {
    const out = cardsForSources([
      { result: undefined, component: 'compute', services: ['app', 'worker'] },
      { result: { series: [owned('db', 'cpu_cores', 'vCPU', 0.2)] }, component: 'db', services: ['db'] },
    ], WIN, undefined, 'compute')
    const names = out.cards.flatMap((c) => c.lines.map((l) => l.name))
    expect(names).not.toContain('app')
    expect(names).not.toContain('worker')
    expect(out.cards.find((c) => c.title === 'CPU Usage')?.lines.map((l) => l.name)).toEqual(['db'])
  })

  it('still zero-fills a source that answered with no samples', () => {
    const out = cardsForSources([
      { result: { series: [] }, component: 'compute', services: ['app', 'worker'] },
      { result: { series: [owned('db', 'cpu_cores', 'vCPU', 0.2)] }, component: 'db', services: ['db'] },
    ], WIN, undefined, 'compute')
    expect(out.cards.find((c) => c.title === 'CPU Usage')?.lines.map((l) => l.name)).toEqual(['app', 'worker', 'db'])
  })
})

describe('cardsForSources (regression: the page went blank in production)', () => {
  it('zero-fills when every source is empty but none carries a note', () => {
    const out = cardsForSources([
      { result: { series: [] }, component: 'compute', services: ['app'] },
      { result: { series: [] }, component: 'db', services: ['db'] },
    ], WIN, undefined, 'compute')
    expect(out.note).toBeUndefined()
    expect(out.cards.map((c) => c.title)).toEqual(['CPU Usage', 'Memory Usage', 'Network Egress'])
    expect(out.cards.every((c) => c.lines.length > 0)).toBe(true)
  })

  it('never returns zero cards while it has no note to show instead', () => {
    for (const sources of [
      [],
      [{ result: { series: [] }, component: 'compute' as const }],
      [{ result: undefined, component: 'compute' as const, services: ['app'] }],
    ]) {
      const out = cardsForSources(sources, WIN, undefined, 'compute')
      if (!out.note) expect(out.cards.length).toBeGreaterThan(0)
    }
  })

  it('shows a note instead of cards when a source reports one', () => {
    const out = cardsForSources([{ result: { series: [], note: 'nothing deployed on this branch' }, component: 'compute' }], WIN, undefined, 'compute')
    expect(out.note).toMatch(/nothing deployed/)
  })

  it('still charts real data, and marks the view as service-keyed', () => {
    const out = cardsForSources([
      { result: { series: [owned('app', 'cpu_cores', 'vCPU', 0.4)] }, component: 'compute', services: ['app', 'worker'] },
    ], WIN, undefined, 'compute')
    expect(out.byService).toBe(true)
    expect(out.cards.find((c) => c.title === 'CPU Usage')?.lines.map((l) => l.name)).toEqual(['app', 'worker'])
  })
})
