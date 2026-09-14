// Before the sampler has any history for a target, runtimeMetrics answers one live `docker stats`
// reading, stamped now. That reading belongs only to a window that contains now: a historical window
// with no history is empty, never a point outside the range asked for.
import { test, expect, beforeEach, vi } from 'vitest'
import { makeEngine, resetFakes, testConfig } from './fakes'
import type { Engine } from '../src/engine'

// Only `docker stats` is faked, so the live reading has something to report; every other call goes to
// the real function, as in the rest of the engine tests.
vi.mock('../src/docker', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/docker')>()
  const row = '{"Name":"io-demo-main-app-default","CPUPerc":"50.00%","MemUsage":"10MiB / 1GiB","NetIO":"0B / 0B"}\n'
  return {
    ...orig,
    docker: (args: string[], opts?: { input?: Buffer; mergeStderr?: boolean }) =>
      args[0] === 'stats' ? Promise.resolve(Buffer.from(row)) : orig.docker(args, opts),
  }
})

let engine: Engine
let projectId: string

beforeEach(async () => {
  resetFakes()
  engine = makeEngine(testConfig())
  projectId = (await engine.createProject('demo')).project.id
  await engine.deploy(projectId, 'main', { image: 'nginx', port: 80 })
})

test('control: with no history, a window containing now is answered the live reading', async () => {
  const now = Math.floor(Date.now() / 1000)
  const r = await engine.runtimeMetrics(projectId, { component: 'compute', window: { from: now - 3_600, to: now + 60, step: 60 } })
  expect(r.series.find((s) => s.name === 'cpu_cores')?.points[0]?.[1]).toBe(0.5)
})

test('with no history, a historical window is empty rather than a point stamped now', async () => {
  const r = await engine.runtimeMetrics(projectId, { component: 'compute', window: { from: 0, to: 60, step: 60 } })
  expect(r.series).toEqual([])
})
