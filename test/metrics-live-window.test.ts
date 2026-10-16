// Before the sampler has any history for a target, runtimeMetrics answers one live `docker stats`
// reading, stamped now. That reading belongs only to a window that contains now: a historical window
// with no history is empty, never a point outside the range asked for.
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeEngine, resetFakes, testConfig } from './fakes'
import type { Engine } from '../src/engine'

const stats = vi.hoisted(() => vi.fn())

// Only `docker stats` is faked, so the live reading has something to report; every other call goes to
// the real function, as in the rest of the engine tests.
vi.mock('../src/docker', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/docker')>()
  return {
    ...orig,
    docker: (args: string[], opts?: { input?: Buffer; mergeStderr?: boolean }) =>
      args[0] === 'stats' ? stats(args) : orig.docker(args, opts),
  }
})

let engine: Engine
let projectId: string

beforeEach(async () => {
  resetFakes()
  stats.mockReset().mockResolvedValue(Buffer.from('{"Name":"io-demo-main-app-default","CPUPerc":"50.00%","MemUsage":"10MiB / 1GiB","NetIO":"0B / 0B"}\n'))
  engine = makeEngine(testConfig())
  projectId = (await engine.createProject('demo')).project.id
  await engine.deploy(projectId, 'main', { image: 'nginx', port: 80 })
})

afterEach(() => { vi.restoreAllMocks() })

test('control: with no history, a window containing now is answered the live reading', async () => {
  const now = Math.floor(Date.now() / 1000)
  const r = await engine.runtimeMetrics(projectId, { component: 'compute', window: { from: now - 3_600, to: now + 60, step: 60 } })
  expect(r.series.find((s) => s.name === 'cpu_cores')?.points[0]?.[1]).toBe(0.5)
})

test('with no history, a historical window is empty rather than a point stamped now', async () => {
  const r = await engine.runtimeMetrics(projectId, { component: 'compute', window: { from: 0, to: 60, step: 60 } })
  expect(r.series).toEqual([])
})

for (const failLiveRead of [false, true]) {
  test(`a sampled sibling keeps its history when the new service's live read ${failLiveRead ? 'fails' : 'succeeds'}`, async () => {
    await engine.deploy(projectId, 'main', { image: 'nginx', port: 80, group: 'older' })
    const now = Math.floor(Date.now() / 1000) + 120
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000)
    engine.metricsHistory.record(now - 60, [{ name: 'io-demo-main-app-older', cpuCores: 0.25, memBytes: 100, rxBytes: 0, txBytes: 0 }])
    if (failLiveRead) stats.mockRejectedValueOnce(new Error('stats unavailable'))

    const result = await engine.runtimeMetrics(projectId, { component: 'compute', window: { from: now - 300, to: now, step: 60 } })
    expect(stats).toHaveBeenCalledOnce()
    expect(stats.mock.calls[0]![0]).toEqual(['stats', '--no-stream', '--format', '{{json .}}', 'io-demo-main-app-default'])
    expect(result.series.filter((s) => s.name === 'cpu_cores')).toEqual([
      { name: 'cpu_cores', unit: 'vCPU', labels: { group: 'older', instance: 'io-demo-main-app-older' }, points: [[Math.floor((now - 60) / 60) * 60, 0.25]] },
      ...(failLiveRead ? [] : [{ name: 'cpu_cores', unit: 'vCPU', labels: { group: 'default', instance: 'io-demo-main-app-default' }, points: [[now, 0.5]] }]),
    ])
  })
}
