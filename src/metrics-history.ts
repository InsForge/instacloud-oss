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
/** The widest gap a network rate is differenced across: one 30 s tick, plus one missed to a failed
 *  `docker stats`, with room to spare. Wider than this the daemon was not watching, and the chart
 *  shows a gap rather than a rate averaged over the outage. */
export const MAX_RATE_GAP_SEC = 120

/** One container's reading at one instant. Network counters are CUMULATIVE since the container
 *  started, as `docker stats` reports them; rates are derived between consecutive samples of the same
 *  `generation` — the container instance, which a redeploy replaces under the same name. */
export interface ContainerSample { name: string; cpuCores: number; memBytes: number; rxBytes: number; txBytes: number; generation?: number }

/** A container a request covers, and the service it is drawn as. */
export interface MetricsTarget { container: string; group: string }

/** Version 2 stores a generation per sample; a version-1 file (no generation) loads as generation 0. */
export interface PersistedHistory { version: 2; samples: Record<string, number[]> }

export type MetricsWindow = { from: number; to: number; step: number }

/** Values stored per sample: t, cpu cores, memory bytes, received bytes, sent bytes, generation. */
const FIELDS = 6
/** Version 1's per-sample values: everything above but the generation. */
const V1_FIELDS = 5

const clean = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)
const generationValue = (n: unknown): number => (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0)
const round = (n: number, digits: number): number => Number(n.toFixed(digits))

export class MetricsHistory {
  /** container -> flat [t, cpu, mem, rx, tx, generation, t, cpu, …], ascending t. */
  private samples = new Map<string, number[]>()

  record(t: number, rows: readonly ContainerSample[]): void {
    for (const r of rows) {
      if (!r.name) continue
      let arr = this.samples.get(r.name)
      if (!arr) { arr = []; this.samples.set(r.name, arr) }
      // A clock step back or a duplicate tick must not break the ascending order the query relies on.
      if (arr.length >= FIELDS && arr[arr.length - FIELDS]! >= t) continue
      arr.push(t, round(clean(r.cpuCores), 6), Math.round(clean(r.memBytes)), Math.round(clean(r.rxBytes)), Math.round(clean(r.txBytes)), generationValue(r.generation))
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
        if (i >= FIELDS && this.differenceable(arr, i)) {
          const dt = t - arr[i - FIELDS]!
          const rx = arr[i + 3]! - arr[i - FIELDS + 3]!
          const tx = arr[i + 4]! - arr[i - FIELDS + 4]!
          b[3]! += rx / dt
          b[4]! += tx / dt
          b[5]! += 1
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

  /** Whether the sample at `i` and the one before it are ONE uninterrupted run of cumulative counters,
   *  so their difference is traffic. Every condition is a way the counters stop being one run:
   *  - a different generation: a redeploy or recreate put a new container under the same name, whose
   *    counters start over — whether they have since grown past the old ones or not;
   *  - either sample not running (memory 0, counters recorded as zero): `docker pause` keeps the
   *    counters, so a resumed container differenced against that zero replays its whole lifetime;
   *  - a gap wider than MAX_RATE_GAP_SEC: the daemon was not watching (down, or restarted onto a saved
   *    history), and averaging hours of movement into one bucket invents a rate where the truth is a gap;
   *  - a negative delta: a restart this generation check could not see (a version-1 history). */
  private differenceable(arr: number[], i: number): boolean {
    const prev = i - FIELDS
    const dt = arr[i]! - arr[prev]!
    return arr[i + 5] === arr[prev + 5]
      && arr[i + 2]! > 0 && arr[prev + 2]! > 0
      && dt > 0 && dt <= MAX_RATE_GAP_SEC
      && arr[i + 3]! >= arr[prev + 3]! && arr[i + 4]! >= arr[prev + 4]!
  }

  toJSON(): PersistedHistory {
    return { version: 2, samples: Object.fromEntries(this.samples) }
  }

  /** Replace the history with a saved one. Malformed containers are skipped rather than failing the
   *  load, out-of-order samples are dropped, and anything past retention is pruned. A version-1 file
   *  loads with every sample at generation 0. */
  load(raw: unknown, nowSec: number): void {
    this.samples.clear()
    const version = raw && typeof raw === 'object' ? (raw as { version?: unknown }).version : undefined
    if (version !== 1 && version !== 2) return
    const width = version === 1 ? V1_FIELDS : FIELDS
    const saved = (raw as { samples?: unknown }).samples
    if (!saved || typeof saved !== 'object') return
    for (const [name, arr] of Object.entries(saved as Record<string, unknown>)) {
      if (!Array.isArray(arr) || arr.length % width !== 0) continue
      if (!arr.every((n) => typeof n === 'number' && Number.isFinite(n))) continue
      const kept: number[] = []
      for (let i = 0; i < arr.length; i += width) {
        if (kept.length >= FIELDS && kept[kept.length - FIELDS]! >= (arr[i] as number)) continue
        const values = arr.slice(i + 1, i + V1_FIELDS) as number[]
        kept.push(arr[i] as number, ...values.map(clean), width === FIELDS ? generationValue(arr[i + 5]) : 0)
      }
      if (kept.length) this.samples.set(name, kept)
    }
    this.prune(nowSec)
  }
}

/** A step as the cloud spells it: "60s", "5m", "1h", or bare seconds. Safe integers only: a long
 *  enough digit string is `Infinity` to Number(), which is "greater than zero" and would coarsen
 *  every bucket timestamp into NaN. */
export function parseStep(v: string): number | null {
  const m = /^(\d+)(s|m|h)?$/.exec(v.trim())
  if (!m) return null
  const seconds = Number(m[1]) * { s: 1, m: 60, h: 3_600 }[(m[2] ?? 's') as 's' | 'm' | 'h']
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null
}

/** The window a metrics request covers, from its query string. Absent values take the cloud's
 *  defaults (the last hour at 60 s); a step that would exceed MAX_POINTS is coarsened. */
export function metricsWindow(q: { from?: unknown; to?: unknown; step?: unknown }, nowSec: number): MetricsWindow | { error: string } {
  // A query string can repeat a key (`?step=60s&step=5m`), which the parser hands over as an array:
  // malformed input, and a 400, not something to call .trim() on.
  if ([q.from, q.to, q.step].some((v) => v !== undefined && typeof v !== 'string')) {
    return { error: 'from, to and step may each be given once' }
  }
  const [fromQ, toQ, stepQ] = [q.from, q.to, q.step] as Array<string | undefined>
  const seconds = (v: string | undefined, fallback: number): number | null =>
    v === undefined || v === '' ? fallback : /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null
  const to = seconds(toQ, nowSec)
  const from = to === null ? null : seconds(fromQ, to - DEFAULT_WINDOW_SEC)
  if (to === null || from === null) return { error: 'from and to must be unix seconds' }
  let step = stepQ === undefined || stepQ === '' ? DEFAULT_STEP_SEC : parseStep(stepQ)
  if (step === null) return { error: 'step must be seconds, or a number with s, m or h (60s, 5m, 1h)' }
  if (from >= to) return { error: 'from must be before to' }
  // Both ends are inclusive and samples floor onto bucket starts, so a window holds up to
  // span / step + 1 buckets, not span / step: an aligned 0..120000 at 60 s is 2,001.
  if ((to - from) / step + 1 > MAX_POINTS) step = Math.ceil((to - from) / (MAX_POINTS - 1))
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
