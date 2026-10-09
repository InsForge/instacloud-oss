// Integration (real Docker, RUN_DOCKER_TESTS=1): the BuildKit git-context path the daemon actually
// uses, driven through the PRODUCTION `dockerBuildSpec` + real `docker()`. The route/engine suites
// mock docker; this is the required real-Docker coverage for the container-facing build (CONTRIBUTING:
// "integration tests (real Docker) for anything touching containers"). It proves BuildKit fetches the
// remote git context, that the pushed SHA is what gets checked out (a bogus SHA fails), and that the
// GIT_AUTH_TOKEN `--secret` plumbing is accepted by real BuildKit. Full private-repo authentication
// needs a private repo + live PAT (not available in CI); it is verified on-box and was measured by the
// reviewer, and here the secret path is exercised against a public repo (an unused secret must build).
import { test, expect, afterAll } from 'vitest'
import { docker } from '../src/docker'
import { dockerBuildSpec } from '../src/gitdeploy'

// A tiny, stable public repo with a root Dockerfile, pinned to a real historical commit (a specific
// SHA stays checkoutable indefinitely). If it ever disappears the test fails loudly, exactly as the
// registry pulls in the other .int suites would.
const REPO = { owner: 'docker', repo: 'welcome-to-docker', token: '' }
const SHA = '68c1b9f87c41fb3fef2667e27149865c2f42d1eb'

const tags: string[] = []
const tag = (s: string): string => { const t = `io-git-inttest-${s}:v1`; tags.push(t); return t }
afterAll(async () => { for (const t of tags) { try { await docker(['rmi', '-f', t]) } catch { /* best effort */ } } })

test('a git-context build at a pinned SHA fetches the remote and produces an image', async () => {
  const t = tag('ok')
  const spec = dockerBuildSpec(REPO, t, SHA)
  await docker(spec.args, { env: spec.env })               // BuildKit fetches the git context + builds
  await expect(docker(['image', 'inspect', t])).resolves.toBeDefined() // the image really exists
}, 300_000)

test('a build pinned to a nonexistent SHA fails, so the fragment truly drives the checkout', async () => {
  const spec = dockerBuildSpec(REPO, tag('bogus'), '0'.repeat(40))
  await expect(docker(spec.args, { env: spec.env })).rejects.toThrow() // "reference is not a tree"
}, 120_000)

test('the GIT_AUTH_TOKEN --secret plumbing is accepted by BuildKit', async () => {
  // A private repo would consume the secret for auth; on a public repo it is unused, so a successful
  // build proves the `--secret id=GIT_AUTH_TOKEN,env=GIT_AUTH_TOKEN` flag + child env do not break it.
  const t = tag('secret')
  const spec = dockerBuildSpec({ ...REPO, token: 'ghp_unused_for_public' }, t, SHA)
  expect(spec.args).toContain('--secret')
  expect(spec.env.GIT_AUTH_TOKEN).toBe('ghp_unused_for_public')
  expect(spec.args.join(' ')).not.toContain('ghp_unused_for_public') // token stays out of argv
  await docker(spec.args, { env: spec.env })
  await expect(docker(['image', 'inspect', t])).resolves.toBeDefined()
}, 300_000)
