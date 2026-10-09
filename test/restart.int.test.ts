// Integration (real Docker): a redeploy REPLACES the container and the replacement carries the new
// env, keeping its host mapping. That is the container-level guarantee `engine.restart` rests on —
// env reaches a container at `docker run`, so a changed secret cannot arrive without the container
// being replaced, which is why restart is a redeploy here and not `docker restart`.
//
// Deliberately at the adapter, not through the Engine: the engine half (restart re-runs the
// RECORDED image/port/hostPort, refuses a non-running service, gates on `deploy`) is covered by the
// contract tests in server.test.ts, and driving this through engine.createProject would stand up a
// postgres and a bucket per run — enough extra Docker load to push the two existing integration
// files past the shared 120s timeout when vitest runs the three in parallel (measured).
import { test, expect, afterAll } from 'vitest'
import { DockerCompute } from '../src/adapters/compute'
import { docker } from '../src/docker'

const REF = 'restartint-main'
const GROUP = 'web'
const CONTAINER = `io-${REF}-app-${GROUP}`
const NETWORK = `io-${REF}`
const IMAGE = 'nginx:alpine' // an image whose DEFAULT command stays in the foreground

const compute = new DockerCompute()
const inspect = async (fmt: string): Promise<string> =>
  (await docker(['inspect', '-f', fmt, CONTAINER])).toString().trim()
const marker = async (): Promise<string> =>
  (await inspect('{{range .Config.Env}}{{println .}}{{end}}'))
    .split('\n').find((l) => l.startsWith('E2E_MARKER='))?.slice('E2E_MARKER='.length) ?? ''

const run = (envVars: Record<string, string>, hostPort: number) =>
  compute.deploy(REF, { image: IMAGE, port: 80, hostPort, network: NETWORK, envVars, group: GROUP })

afterAll(async () => {
  await docker(['rm', '-f', CONTAINER]).catch(() => { /* best-effort */ })
  await docker(['network', 'rm', NETWORK]).catch(() => { /* best-effort */ })
})

test('a redeploy replaces the container with the new env, keeping its host mapping', async () => {
  await docker(['network', 'create', NETWORK]).catch(() => { /* already there */ })

  const first = await run({ E2E_MARKER: 'before' }, 18099)
  expect(new URL(first.url).port).toBe('18099')
  expect(await marker()).toBe('before')
  const idBefore = await inspect('{{.Id}}')

  // What `docker restart` would do instead: the SAME container comes back, so it still holds the
  // env it was created with. This is the line that makes restart-as-redeploy load-bearing.
  await docker(['restart', '-t', '1', CONTAINER])  // -t 1: no 10s graceful-stop wait
  expect(await inspect('{{.Id}}')).toBe(idBefore)
  expect(await marker()).toBe('before')

  await run({ E2E_MARKER: 'after' }, 18099)
  expect(await marker()).toBe('after')                  // the fresh bundle reached the container
  expect(await inspect('{{.Id}}')).not.toBe(idBefore)   // a NEW container, not a kick
  expect(await inspect('{{.State.Running}}')).toBe('true')
  expect(await inspect('{{json .NetworkSettings.Ports}}')).toContain('18099')
})

// WHY a suspended service's replacement must still be started: suspend is `docker pause`, and Docker
// refuses to pause a container that was created and never started. The engine relies on this, so it
// is pinned here rather than assumed — if Docker ever allowed it, `start: false` could cover suspend
// too and the extra boot would be removable.
test('docker cannot pause a container that was created but never started', async () => {
  await docker(['network', 'create', NETWORK]).catch(() => { /* already there */ })
  await docker(['rm', '-f', CONTAINER]).catch(() => { /* not there */ })
  await compute.deploy(REF, { image: IMAGE, port: 80, hostPort: 18098, network: NETWORK, envVars: {}, group: GROUP, start: false })
  expect(await inspect('{{.State.Status}}')).toBe('created')
  await expect(docker(['pause', CONTAINER])).rejects.toThrow()
  expect(await inspect('{{.State.Status}}')).toBe('created')   // still not suspended
})
