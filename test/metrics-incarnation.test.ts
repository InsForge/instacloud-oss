// Container names come from project, branch and service NAMES, so a project deleted and recreated under
// the same name runs its containers under the same names, and the metrics history (keyed by container)
// still holds the deleted project's samples for up to three days. The recreated project must not be
// shown them as its own.
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeEngine, resetFakes, testConfig } from './fakes'
import type { Engine } from '../src/engine'

let engine: Engine
// Only Date is faked: creation times come from Date.now(), and the engine's own awaits must still run.
const T0 = 1_800_000_000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0 * 1000)
  resetFakes()
  engine = makeEngine(testConfig())
})

afterEach(() => { vi.useRealTimers() })

const CONTAINER = 'io-demo-main-app-default'
const pointTimes = (series: Array<{ points: Array<[number, number]> }>): number[] => series.flatMap((s) => s.points.map(([t]) => t))

test("delete, recreate under the same name: the new project's metrics carry none of the old project's samples", async () => {
  const first = (await engine.createProject('demo')).project
  await engine.deploy(first.id, 'main', { image: 'nginx', port: 80 })
  const old = [T0 + 10, T0 + 40]
  for (const t of old) engine.metricsHistory.record(t, [{ name: CONTAINER, cpuCores: 0.9, memBytes: 900, rxBytes: 0, txBytes: 0 }])
  vi.setSystemTime((T0 + 600) * 1000)
  const window = { from: T0, to: T0 + 3_600, step: 60 }

  // Control: the samples are the first project's, under the container name its service runs as.
  const before = await engine.runtimeMetrics(first.id, { component: 'compute', window })
  expect(pointTimes(before.series).length).toBeGreaterThan(0)

  await engine.destroyProject(first.id)
  const second = (await engine.createProject('demo')).project
  await engine.deploy(second.id, 'main', { image: 'nginx', port: 80 })

  const after = await engine.runtimeMetrics(second.id, { component: 'compute', window })
  expect(pointTimes(after.series).filter((t) => t <= old[1]!)).toEqual([])
  expect(after.series.flatMap((s) => s.points.map(([, v]) => v))).not.toContain(0.9)
})
