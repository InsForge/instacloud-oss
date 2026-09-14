// The daemon's own CPU, memory and network history, so the dashboard charts 1h / 6h / 24h / 3d the way
// the cloud console does. The cloud reads metrics its provider already retains; a self-hosted box has
// only `docker stats`, which is a reading of NOW, so the daemon samples it on a timer
// (metrics-sampler.ts) and answers range queries from the samples kept here.
//
// Series use the cloud's names and units (platform openapi MetricsResult): `cpu_cores` (vCPU),
// `memory_used_bytes`, and `egress_bytes_rate` / `ingress_bytes_rate`, each labelled with the service
// it belongs to (`group`), so the console's card code renders them unchanged.

import { parseSize, type MetricSeries } from './observe'

/** Samples older than this are dropped: the longest range the console offers is 3d. */
export const RETENTION_SEC = 3 * 86_400 + 3_600
/** The cloud's implicit window when a request names none: the last hour, one point a minute. */
export const DEFAULT_WINDOW_SEC = 3_600
export const DEFAULT_STEP_SEC = 60
/** No series is answered with more points than this; a step that would exceed it is coarsened. */
export const MAX_POINTS = 2_000

/** One container's reading at one instant. Network counters are CUMULATIVE since the container
 *  started, as `docker stats` reports them; rates are derived between consecutive samples. */
export interface ContainerSample { name: string; cpuCores: number; memBytes: number; rxBytes: number; txBytes: number }

/** A container a request covers, and the service it is drawn as. */
export interface MetricsTarget { container: string; group: string }

export interface PersistedHistory { version: 1; samples: Record<string, number[]> }

export type MetricsWindow = { from: number; to: number; step: number }

/** Values stored per sample: t, cpu cores, memory bytes, received bytes, sent bytes. */
const FIELDS = 5

const clean = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)
const round = (n: number, digits: number): number => Number(n.toFixed(digits))

export class MetricsHistory {
  /** container -> flat [t, cpu, mem, rx, tx, t, cpu, …], ascending t. */
  private samples = new Map<string, number[]>()

  record(t: number, rows: readonly ContainerSample[]): void {
    for (const r of rows) {
      if (!r.name) continue
      let arr = this.samples.get(r.name)
      if (!arr) { arr = []; this.samples.set(r.name, arr) }
      // A clock step back or a duplicate tick must not break the ascending order the query relies on.
      if (arr.length >= FIELDS && arr[arr.length - FIELDS]! >= t) continue
      arr.push(t, round(clean(r.cpuCores), 6), Math.round(clean(r.memBytes)), Math.round(clean(r.rxBytes)), Math.round(clean(r.txBytes)))
    }
  }

  /** Drop everything older than RETENTION_SEC, and containers left with nothing. */
  prune(nowSec: number): void {
    const cutoff = nowSec - RETENTION_SEC
    for (const [name, arr] of this.samples) {
      let i = 0
      while (i < arr.length && arr[i]! < cutoff) i += FIELDS
      if (i >= arr.length) this.samples.delete(name)
      else if (i > 0) arr.splice(0, i)
    }
  }

  /** Whether any of these containers has ever been sampled. */
  sampled(containers: readonly string[]): boolean {
    return containers.some((c) => this.samples.has(c))
  }

  /** Series for `targets` over [from, to], averaged into `step`-second buckets labelled by their start.
   *  A target with no samples in the window reports no series: the console zero-fills it. */
  query(targets: readonly MetricsTarget[], from: number, to: number, step: number): MetricSeries[] {
    const out: MetricSeries[] = []
    for (const { container, group } of targets) {
      const arr = this.samples.get(container)
      if (!arr) continue
      // bucket start -> [cpu sum, memory sum, samples, rx rate sum, tx rate sum, rates]
      const buckets = new Map<number, number[]>()
      for (let i = 0; i < arr.length; i += FIELDS) {
        const t = arr[i]!
        if (t < from || t > to) continue
        const key = Math.floor(t / step) * step
        let b = buckets.get(key)
        if (!b) { b = [0, 0, 0, 0, 0, 0]; buckets.set(key, b) }
        b[0]! += arr[i + 1]!
        b[1]! += arr[i + 2]!
        b[2]! += 1
        if (i >= FIELDS) {
          const dt = t - arr[i - FIELDS]!
          const rx = arr[i + 3]! - arr[i - FIELDS + 3]!
          const tx = arr[i + 4]! - arr[i - FIELDS + 4]!
          // Counters restart with the container: a negative delta is a new container, not negative traffic.
          if (dt > 0 && rx >= 0 && tx >= 0) { b[3]! += rx / dt; b[4]! += tx / dt; b[5]! += 1 }
        }
      }
      if (buckets.size === 0) continue
      const keys = [...buckets.keys()].sort((a, b) => a - b)
      const at = (k: number): number[] => buckets.get(k)!
      const labels = { group, instance: container }
      out.push({ name: 'cpu_cores', unit: 'vCPU', labels, points: keys.map((k) => [k, round(at(k)[0]! / at(k)[2]!, 6)]) })
      out.push({ name: 'memory_used_bytes', unit: 'bytes', labels, points: keys.map((k) => [k, Math.round(at(k)[1]! / at(k)[2]!)]) })
      // A bucket holding only the container's first sample has nothing to difference against.
      const rated = keys.filter((k) => at(k)[5]! > 0)
      if (rated.length) {
        out.push({ name: 'egress_bytes_rate', unit: 'bytes/s', labels, points: rated.map((k) => [k, round(at(k)[4]! / at(k)[5]!, 3)]) })
        out.push({ name: 'ingress_bytes_rate', unit: 'bytes/s', labels, points: rated.map((k) => [k, round(at(k)[3]! / at(k)[5]!, 3)]) })
      }
    }
    return out
  }

  toJSON(): PersistedHistory {
    return { version: 1, samples: Object.fromEntries(this.samples) }
  }

  /** Replace the history with a saved one. Malformed containers are skipped rather than failing the
   *  load, out-of-order samples are dropped, and anything past retention is pruned. */
  load(raw: unknown, nowSec: number): void {
    this.samples.clear()
    if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 1) return
    const saved = (raw as { samples?: unknown }).samples
    if (!saved || typeof saved !== 'object') return
    for (const [name, arr] of Object.entries(saved as Record<string, unknown>)) {
      if (!Array.isArray(arr) || arr.length % FIELDS !== 0) continue
      if (!arr.every((n) => typeof n === 'number' && Number.isFinite(n))) continue
      const kept: number[] = []
      for (let i = 0; i < arr.length; i += FIELDS) {
        if (kept.length >= FIELDS && kept[kept.length - FIELDS]! >= (arr[i] as number)) continue
        kept.push(arr[i] as number, ...(arr.slice(i + 1, i + FIELDS) as number[]).map(clean))
      }
      if (kept.length) this.samples.set(name, kept)
    }
    this.prune(nowSec)
  }
}

/** A step as the cloud spells it: "60s", "5m", "1h", or bare seconds. */
export function parseStep(v: string): number | null {
  const m = /^(\d+)(s|m|h)?$/.exec(v.trim())
  if (!m) return null
  const seconds = Number(m[1]) * { s: 1, m: 60, h: 3_600 }[(m[2] ?? 's') as 's' | 'm' | 'h']
  return seconds > 0 ? seconds : null
}

/** The window a metrics request covers, from its query string. Absent values take the cloud's
 *  defaults (the last hour at 60 s); a step that would exceed MAX_POINTS is coarsened. */
export function metricsWindow(q: { from?: string; to?: string; step?: string }, nowSec: number): MetricsWindow | { error: string } {
  const seconds = (v: string | undefined, fallback: number): number | null =>
    v === undefined || v === '' ? fallback : /^\d+$/.test(v) ? Number(v) : null
  const to = seconds(q.to, nowSec)
  const from = to === null ? null : seconds(q.from, to - DEFAULT_WINDOW_SEC)
  if (to === null || from === null) return { error: 'from and to must be unix seconds' }
  let step = q.step === undefined || q.step === '' ? DEFAULT_STEP_SEC : parseStep(q.step)
  if (step === null) return { error: 'step must be seconds, or a number with s, m or h (60s, 5m, 1h)' }
  if (from >= to) return { error: 'from must be before to' }
  if ((to - from) / step > MAX_POINTS) step = Math.ceil((to - from) / MAX_POINTS)
  return { from, to, step }
}

/** `docker stats --no-stream --format '{{json .}}'` rows -> samples. CPUPerc is a percentage of ONE
 *  core (a busy two-core container reads 200%), so cores are that divided by 100. NetIO is
 *  "received / sent" since the container started. */
export function statsToSamples(raw: string): ContainerSample[] {
  const out: ContainerSample[] = []
  for (const line of raw.split('\n').filter(Boolean)) {
    let row: { Name?: string; CPUPerc?: string; MemUsage?: string; NetIO?: string }
    try { row = JSON.parse(line) } catch { continue }
    if (!row.Name) continue
    const [rx, tx] = (row.NetIO ?? '').split('/')
    out.push({
      name: row.Name,
      cpuCores: (Number((row.CPUPerc ?? '0').replace('%', '')) || 0) / 100,
      memBytes: parseSize((row.MemUsage ?? '0B').split('/')[0] ?? ''),
      rxBytes: parseSize(rx ?? ''),
      txBytes: parseSize(tx ?? ''),
    })
  }
  return out
}

/** One live reading as series, for a request that arrives before the sampler's first tick. No
 *  network rate: a single cumulative counter has nothing to difference against. */
export function liveSeries(samples: readonly ContainerSample[], targets: readonly MetricsTarget[], nowSec: number): MetricSeries[] {
  const byName = new Map(samples.map((s) => [s.name, s]))
  const out: MetricSeries[] = []
  for (const { container, group } of targets) {
    const s = byName.get(container)
    if (!s) continue
    const labels = { group, instance: container }
    out.push({ name: 'cpu_cores', unit: 'vCPU', labels, points: [[nowSec, round(clean(s.cpuCores), 6)]] })
    out.push({ name: 'memory_used_bytes', unit: 'bytes', labels, points: [[nowSec, Math.round(clean(s.memBytes))]] })
  }
  return out
}
