// The two behaviours a webhook build depends on but a mocked-docker route test cannot prove, driven
// through the real Engine over the fake adapters: (1) a git redeploy PRESERVES the service's
// configured port instead of resetting it to 8080, and (2) a build that finishes after its target
// was removed does NOT re-materialise the group — deployFromGit returns null under the service lock.
import { test, expect, beforeEach, vi } from 'vitest'
import { calls, makeEngine, resetFakes, runtime, testConfig } from './fakes'
import { mutate } from '../src/state'
import { newBinding } from '../src/gitdeploy'
import type { Engine } from '../src/engine'

// Service removal runs `docker rm`, then proves the container gone before it drops the row (same
// pattern as metrics-incarnation.test.ts): a faked `docker rm` really removes it from FakeRuntime,
// and `docker ps` answers an empty listing so the proof sees it gone. Deploy uses the fake compute
// adapter, not docker, so nothing else here needs the real binary.
function fakeRemoval(args: string[]): Promise<Buffer> {
  if (args[0] === 'rm') for (const a of args.slice(1)) if (!a.startsWith('-')) runtime.drop(a)
  return Promise.resolve(Buffer.from(''))
}
vi.mock('../src/docker', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/docker')>()
  return {
    ...orig,
    docker: (args: string[], opts?: { input?: Buffer; mergeStderr?: boolean }) =>
      args[0] === 'rm' || args[0] === 'ps' ? fakeRemoval(args) : orig.docker(args, opts),
  }
})

let engine: Engine
let projectId: string
let branchId: string

/** Seed a git binding for group `web` on the default branch and return its id. */
function seedBinding(): string {
  const b = newBinding('owner', 'repo', 'main', 'ghp_tok', Date.now())
  mutate((s) => {
    s.gitBindings = { ...(s.gitBindings ?? {}), [b.id]: { binding: b, projectId, branchId, branchName: 'main', group: 'web' } }
  })
  return b.id
}

beforeEach(async () => {
  resetFakes()
  engine = makeEngine(testConfig())
  // A project name unique to this file: engine tests create a REAL docker network io-<ref>-main, and
  // reusing "demo" collides with the other engine suites when vitest runs files in parallel.
  const { project } = await engine.createProject('gitdep')
  projectId = project.id
  // A service on a NON-8080 port: the whole point of the port-preservation check.
  await engine.deploy(projectId, 'main', { image: 'app:1', port: 3000, group: 'web' })
  branchId = engine.getBranchByName(projectId, 'main')!.id
})

test('a git redeploy preserves the service’s configured port (never resets to 8080)', async () => {
  const bindingId = seedBinding()
  calls.length = 0
  const res = await engine.deployFromGit(projectId, branchId, 'web', bindingId, 'app:2')
  expect(res).toEqual({ deployed: true, port: 3000 })
  const deployLine = calls.find((c) => c.startsWith('deploy:') && c.includes(':app:2:'))
  expect(deployLine).toBeDefined()
  expect(deployLine).toContain('p=3000->') // preserved, not the deployLocked default of 8080
})

test('a build that finished after its target was removed does not re-materialise the group', async () => {
  const bindingId = seedBinding()
  await engine.removeComputeService(projectId, 'cp-web')
  calls.length = 0
  const res = await engine.deployFromGit(projectId, branchId, 'web', bindingId, 'app:2')
  expect(res).toBeNull()
  expect(calls.some((c) => c.startsWith('deploy:'))).toBe(false) // no re-create
})

test('a redeploy for a binding that no longer exists is a no-op', async () => {
  calls.length = 0
  const res = await engine.deployFromGit(projectId, branchId, 'web', 'no-such-binding', 'app:2')
  expect(res).toBeNull()
  expect(calls.some((c) => c.startsWith('deploy:'))).toBe(false)
})
