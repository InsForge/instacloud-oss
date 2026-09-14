import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  liveSeries, MAX_POINTS, MAX_RATE_GAP_SEC, MetricsHistory, metricsWindow, parseStep, RETENTION_SEC, statsToSamples,
  type ContainerSample,
} from '../src/metrics-history'
import { MetricsSampler, PERSIST_INTERVAL_SEC } from '../src/metrics-sampler'

const sample = (name: string, cpuCores: number, memBytes: number, rxBytes = 0, txBytes = 0): ContainerSample =>
  ({ name, cpuCores, memBytes, rxBytes, txBytes })
const APP = { container: 'io-demo-main-app-web', group: 'web' }
const named = (series: ReturnType<MetricsHistory['query']>, name: string) => series.filter((s) => s.name === name)

describe('statsToSamples', () => {
  test('reads cores from a per-core percentage, and memory and network in docker units', () => {
    const raw = [
      '{"Name":"io-a","CPUPerc":"150.00%","MemUsage":"12MiB / 4GiB","NetIO":"1.5kB / 2MB"}',
      'not json',
      '{"CPUPerc":"1%"}',
      '',
    ].join('\n')
    expect(statsToSamples(raw)).toEqual([{ name: 'io-a', cpuCores: 1.5, memBytes: 12 * 1024 ** 2, rxBytes: 1500, txBytes: 2e6 }])
  })
})

describe('MetricsHistory.query', () => {
  test('averages samples into step buckets, in the cloud series names and units, labelled by service', () => {
    const h = new MetricsHistory()
    h.record(600, [sample(APP.container, 0.1, 100)])
    h.record(630, [sample(APP.container, 0.3, 300)])
    h.record(660, [sample(APP.container, 0.5, 500)])
    const series = h.query([APP], 0, 1_000, 60)
    const cpu = named(series, 'cpu_cores')[0]!
    expect(cpu.unit).toBe('vCPU')
    expect(cpu.labels).toEqual({ group: 'web', instance: APP.container })
    expect(cpu.points).toEqual([[600, 0.2], [660, 0.5]])
    expect(named(series, 'memory_used_bytes')[0]!.points).toEqual([[600, 200], [660, 500]])
  })

  test('answers only the window asked for', () => {
    const h = new MetricsHistory()
    for (const t of [100, 200, 300, 400]) h.record(t, [sample(APP.container, 0.1, 1)])
    expect(named(h.query([APP], 200, 300, 100), 'cpu_cores')[0]!.points.map(([t]) => t)).toEqual([200, 300])
    expect(h.query([APP], 1_000, 2_000, 60)).toEqual([])
  })

  test('derives egress and ingress rates from the cumulative counters', () => {
    const h = new MetricsHistory()
    h.record(0, [sample(APP.container, 0, 0, 1_000, 2_000)])
    h.record(30, [sample(APP.container, 0, 0, 4_000, 2_600)])
    const series = h.query([APP], 0, 60, 60)
    // (4000 - 1000) / 30 received, (2600 - 2000) / 30 sent
    expect(named(series, 'ingress_bytes_rate')[0]!.points).toEqual([[0, 100]])
    expect(named(series, 'egress_bytes_rate')[0]!.points).toEqual([[0, 20]])
    expect(named(series, 'egress_bytes_rate')[0]!.unit).toBe('bytes/s')
  })

  test('a counter reset from a restart is not negative traffic', () => {
    const h = new MetricsHistory()
    h.record(0, [sample(APP.container, 0, 0, 9_000, 9_000)])
    h.record(60, [sample(APP.container, 0, 0, 10, 10)])
    expect(named(h.query([APP], 0, 120, 120), 'egress_bytes_rate')).toEqual([])
  })

  test('a lone first sample reports cpu and memory but no rate', () => {
    const h = new MetricsHistory()
    h.record(0, [sample(APP.container, 0.2, 5, 100, 100)])
    expect(h.query([APP], 0, 60, 60).map((s) => s.name)).toEqual(['cpu_cores', 'memory_used_bytes'])
  })

  test('a stopped container recorded at zero draws a flat zero line', () => {
    const h = new MetricsHistory()
    h.record(0, [sample('io-demo-main-pg-db', 0, 0)])
    h.record(60, [sample('io-demo-main-pg-db', 0, 0)])
    const cpu = named(h.query([{ container: 'io-demo-main-pg-db', group: 'db' }], 0, 120, 60), 'cpu_cores')[0]!
    expect(cpu.points).toEqual([[0, 0], [60, 0]])
  })

  test('ignores a sample that does not move time forward, and negative or non-finite readings', () => {
    const h = new MetricsHistory()
    h.record(100, [sample(APP.container, 0.5, 10)])
    h.record(100, [sample(APP.container, 9, 9)])
    h.record(50, [sample(APP.container, 9, 9)])
    h.record(160, [sample(APP.container, -1, Number.NaN)])
    const series = h.query([APP], 0, 1_000, 60)
    expect(named(series, 'cpu_cores')[0]!.points).toEqual([[60, 0.5], [120, 0]])
    expect(named(series, 'memory_used_bytes')[0]!.points).toEqual([[60, 10], [120, 0]])
  })
})

describe('retention and persistence', () => {
  test('prune drops samples past retention and containers left empty', () => {
    const h = new MetricsHistory()
    h.record(0, [sample('io-old', 1, 1)])
    h.record(10, [sample(APP.container, 1, 1)])
    h.record(RETENTION_SEC + 20, [sample(APP.container, 1, 1)])
    h.prune(RETENTION_SEC + 20) // cutoff t=20: both earlier samples are past retention
    expect(h.sampled(['io-old'])).toBe(false)
    expect(named(h.query([APP], 0, RETENTION_SEC + 60, 60), 'cpu_cores')[0]!.points).toHaveLength(1)
  })

  test('a saved history loads back identically', () => {
    const h = new MetricsHistory()
    h.record(100, [sample(APP.container, 0.25, 1_024, 1, 2)])
    h.record(130, [sample(APP.container, 0.5, 2_048, 31, 62)])
    const restored = new MetricsHistory()
    restored.load(JSON.parse(JSON.stringify(h.toJSON())), 200)
    expect(restored.query([APP], 0, 200, 60)).toEqual(h.query([APP], 0, 200, 60))
  })

  test('load skips malformed containers and past-retention samples instead of failing', () => {
    const h = new MetricsHistory()
    h.load({ version: 1, samples: {
      'io-bad-length': [1, 2, 3],
      'io-bad-value': [1, 'x', 0, 0, 0],
      'io-expired': [0, 1, 1, 0, 0],
      [APP.container]: [RETENTION_SEC, 0.1, 10, 0, 0, RETENTION_SEC - 1, 0.9, 90, 0, 0],
    } }, RETENTION_SEC + 60)
    expect(h.sampled(['io-bad-length', 'io-bad-value', 'io-expired'])).toBe(false)
    // the out-of-order second sample is dropped, not sorted in
    expect(named(h.query([APP], 0, RETENTION_SEC + 60, 60), 'cpu_cores')[0]!.points).toHaveLength(1)
    h.load({ version: 2 }, 0)
    h.load(null, 0)
    expect(h.sampled([APP.container])).toBe(false)
  })
})

describe('metricsWindow', () => {
  test('defaults to the last hour at 60 s, like the cloud', () => {
    expect(metricsWindow({}, 10_000)).toEqual({ from: 6_400, to: 10_000, step: 60 })
  })

  test('takes from, to and a step in the cloud spelling', () => {
    expect(metricsWindow({ from: '1000', to: '4600', step: '5m' }, 0)).toEqual({ from: 1_000, to: 4_600, step: 300 })
    expect(parseStep('1h')).toBe(3_600)
    expect(parseStep('90')).toBe(90)
    expect(parseStep('0s')).toBeNull()
    expect(parseStep('5 minutes')).toBeNull()
  })

  test('rejects values that are not unix seconds or a step, and a backwards window', () => {
    expect(metricsWindow({ from: 'yesterday' }, 10_000)).toHaveProperty('error')
    expect(metricsWindow({ to: '-5' }, 10_000)).toHaveProperty('error')
    expect(metricsWindow({ step: 'fast' }, 10_000)).toHaveProperty('error')
    expect(metricsWindow({ from: '500', to: '500' }, 10_000)).toHaveProperty('error')
  })

  test('coarsens a step that would return more than MAX_POINTS points', () => {
    const w = metricsWindow({ from: '0', to: String(3 * 86_400), step: '1s' }, 0)
    expect('step' in w && (w.to - w.from) / w.step).toBeLessThanOrEqual(MAX_POINTS)
  })
})

describe('metricsWindow past safe integers (regression: Infinity became NaN bucket timestamps)', () => {
  const huge = '9'.repeat(400) // Number() of this is Infinity
  test.each([
    { to: huge },
    { from: '0', to: huge },
    { from: huge },
    { step: huge },
    { step: `${huge}s` },
    { step: '9007199254740993' }, // one past MAX_SAFE_INTEGER, rounded by Number()
    { step: '2501999792983609h' }, // safe as a number, not once multiplied into seconds
  ])('rejects %o with a 400-style error', (q) => {
    expect(metricsWindow(q, 10_000)).toHaveProperty('error')
  })

  test('the widest valid window still answers a finite, safe step', () => {
    const w = metricsWindow({ from: '0', to: String(Number.MAX_SAFE_INTEGER), step: '1s' }, 0)
    expect('step' in w && Number.isSafeInteger(w.step) && w.step > 0).toBe(true)
  })
})

describe('network rates across a daemon outage (regression: hours of counter movement pinned on one bucket)', () => {
  test('a sample after a long gap, reloaded from a saved history, starts a new chain: no rate across the outage', () => {
    const before = new MetricsHistory()
    before.record(0, [sample(APP.container, 0, 0, 1_000, 1_000)])
    before.record(30, [sample(APP.container, 0, 0, 2_000, 2_000)])
    const after = new MetricsHistory()
    after.load(JSON.parse(JSON.stringify(before.toJSON())), 60)
    after.record(7_230, [sample(APP.container, 0, 0, 9_000_000, 9_000_000)]) // the daemon was down for two hours
    const egress = named(after.query([APP], 0, 8_000, 60), 'egress_bytes_rate')[0]!
    expect(egress.points.map(([t]) => t)).toEqual([0]) // the pre-outage bucket only; nothing at 7200
  })

  test('a missed tick (one failed docker stats) still differences, within MAX_RATE_GAP_SEC', () => {
    const h = new MetricsHistory()
    h.record(0, [sample(APP.container, 0, 0, 0, 0)])
    h.record(60, [sample(APP.container, 0, 0, 6_000, 0)])
    expect(MAX_RATE_GAP_SEC).toBeGreaterThanOrEqual(60)
    expect(named(h.query([APP], 0, 120, 120), 'ingress_bytes_rate')[0]!.points).toEqual([[0, 100]])
  })
})

describe('MAX_POINTS counts the inclusive endpoint (regression: 2,001 buckets)', () => {
  test('an aligned window exactly one bucket past the cap is coarsened', () => {
    const w = metricsWindow({ from: '0', to: '120000', step: '60s' }, 0)
    expect('step' in w && w.step).toBeGreaterThan(60)
  })

  test('no window ever answers more than MAX_POINTS buckets, sampled every second of it', () => {
    const w = metricsWindow({ from: '0', to: '120000', step: '60s' }, 0)
    if (!('step' in w)) throw new Error('expected a window')
    const h = new MetricsHistory()
    for (let t = w.from; t <= w.to; t += 30) h.record(t, [sample(APP.container, 0.1, 1)])
    const cpu = named(h.query([APP], w.from, w.to, w.step), 'cpu_cores')[0]!
    expect(cpu.points.length).toBeLessThanOrEqual(MAX_POINTS)
  })

  test('a window that fits is left at the step it asked for', () => {
    expect(metricsWindow({ from: '0', to: '119940', step: '60s' }, 0)).toEqual({ from: 0, to: 119_940, step: 60 })
  })
})

test('liveSeries answers one reading per target that docker reported', () => {
  const series = liveSeries([sample(APP.container, 0.0125, 12)], [APP, { container: 'io-gone', group: 'gone' }], 99)
  expect(series).toEqual([
    { name: 'cpu_cores', unit: 'vCPU', labels: { group: 'web', instance: APP.container }, points: [[99, 0.0125]] },
    { name: 'memory_used_bytes', unit: 'bytes', labels: { group: 'web', instance: APP.container }, points: [[99, 12]] },
  ])
})

describe('MetricsSampler', () => {
  const PS = 'io-demo-main-app-web\trunning\nio-demo-main-pg-db\texited\nsomething-else\trunning\n'
  const STATS = '{"Name":"io-demo-main-app-web","CPUPerc":"2.00%","MemUsage":"10MiB / 1GiB","NetIO":"0B / 0B"}\n'
  const fakeDocker = (calls: string[][], stats: () => Promise<Buffer> = async () => Buffer.from(STATS)) =>
    async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'ps') return Buffer.from(PS)
      if (args[0] === 'stats') return stats()
      return Buffer.from('')
    }
  const file = () => join(mkdtempSync(join(tmpdir(), 'metrics-history-')), 'metrics-history.json')

  test('samples running managed containers, records stopped ones at zero, and ignores the rest', async () => {
    const calls: string[][] = []
    const history = new MetricsHistory()
    const sampler = new MetricsSampler(history, { file: file(), docker: fakeDocker(calls), now: () => 1_000, log: () => {} })
    await sampler.sampleOnce()
    const statsCall = calls.find((c) => c[0] === 'stats')!
    expect(statsCall.filter((a) => a.startsWith('io-'))).toEqual(['io-demo-main-app-web'])
    const targets = [APP, { container: 'io-demo-main-pg-db', group: 'db' }]
    const cpu = named(history.query(targets, 0, 2_000, 60), 'cpu_cores')
    expect(cpu.map((s) => [s.labels!.group, s.points[0]![1]])).toEqual([['web', 0.02], ['db', 0]])
    expect(history.sampled(['something-else'])).toBe(false)
  })

  test('a failed docker stats still records the stopped containers', async () => {
    const history = new MetricsHistory()
    const sampler = new MetricsSampler(history, {
      file: file(), docker: fakeDocker([], async () => { throw new Error('No such container') }), now: () => 1_000, log: () => {},
    })
    await sampler.sampleOnce()
    expect(history.sampled(['io-demo-main-pg-db'])).toBe(true)
    expect(history.sampled([APP.container])).toBe(false)
  })

  test('saves owner-only on stop, and a new sampler loads the history back', async () => {
    const path = file()
    let now = 1_000
    const first = new MetricsSampler(new MetricsHistory(), { file: path, docker: fakeDocker([]), now: () => now, intervalSec: 3_600, log: () => {} })
    first.start()
    now += 30
    await first.stop()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const restored = new MetricsHistory()
    const second = new MetricsSampler(restored, { file: path, docker: fakeDocker([]), now: () => now, log: () => {} })
    second.load()
    expect(restored.sampled([APP.container])).toBe(true)
  })

  test('saves on its own every PERSIST_INTERVAL_SEC, not on every tick', async () => {
    const path = file()
    let now = 10_000
    const sampler = new MetricsSampler(new MetricsHistory(), { file: path, docker: fakeDocker([]), now: () => now, log: () => {} })
    sampler.load()
    await sampler.sampleOnce() // first tick of a sampler that never saved: saves
    const saved = readFileSync(path, 'utf8')
    now += 30
    await sampler.sampleOnce()
    expect(readFileSync(path, 'utf8')).toBe(saved)
    now += PERSIST_INTERVAL_SEC
    await sampler.sampleOnce()
    expect(readFileSync(path, 'utf8')).not.toBe(saved)
  })

  test('a sampler that never started does not overwrite a saved history', async () => {
    const path = file()
    writeFileSync(path, '{"version":1,"samples":{"io-kept":[1,0,0,0,0]}}')
    await new MetricsSampler(new MetricsHistory(), { file: path, docker: fakeDocker([]), log: () => {} }).stop()
    expect(readFileSync(path, 'utf8')).toContain('io-kept')
  })

  test('an unreadable saved file is logged and started over, not fatal', () => {
    const path = file()
    writeFileSync(path, '{not json')
    const logs: string[] = []
    const history = new MetricsHistory()
    new MetricsSampler(history, { file: path, docker: fakeDocker([]), log: (m) => logs.push(m) }).load()
    expect(logs.join('\n')).toMatch(/ignoring unreadable/)
    expect(history.sampled([APP.container])).toBe(false)
  })
})
