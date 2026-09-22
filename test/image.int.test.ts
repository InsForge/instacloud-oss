// Integration (real Docker, integrator only: RUN_DOCKER_TESTS=1): the published image boots the daemon.
// Builds the Dockerfile at the repo root, runs it in LOCAL mode (the image bakes INSTA_OSS_MODE=server;
// local mode needs no domain and no auth) with the host's Docker socket and a tmp data dir bound at the
// identical path, the way compose.yml binds <dataDir>, and checks what the compose stack and the
// installer rely on: /healthz answers, the docker CLI inside the image reaches the socket, the dashboard
// and the templates are in the image, GET / serves the SPA shell with the injected window.__INSTA_OSS__
// (WP1), and the image's own HEALTHCHECK reports healthy. Container io-imagetest, port 18080.
import { test, expect, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const IMAGE = 'instacloud:test'
const CONTAINER = 'io-imagetest'
const PORT = 18080
const BASE = `http://127.0.0.1:${PORT}`
// realpath: on macOS the tmp dir is a symlink under /var and the bind must name the path Docker shares
const DATA = realpathSync(mkdtempSync(join(tmpdir(), 'io-imagetest-')))

const docker = (args: string[]): string => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(what: string, probe: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe().catch(() => false)) return
    await sleep(1000)
  }
  throw new Error(`${what} did not happen within ${timeoutMs} ms:\n${spawnSync('docker', ['logs', '--tail', '40', CONTAINER], { encoding: 'utf8' }).stdout}`)
}

afterAll(() => {
  spawnSync('docker', ['rm', '-f', CONTAINER])
  // the daemon writes state.json and instad.lock as root; a non-root runner may not be able to remove them
  try { rmSync(DATA, { recursive: true, force: true }) } catch { /* best-effort */ }
})

test('docker build produces the image with the expected baked configuration', () => {
  const r = spawnSync('docker', ['build', '--build-arg', 'VERSION=test', '-t', IMAGE, ROOT], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`docker build failed:\n${r.stdout}\n${r.stderr}`)
  const env = JSON.parse(docker(['image', 'inspect', IMAGE, '--format', '{{json .Config.Env}}'])) as string[]
  expect(env).toEqual(expect.arrayContaining(['INSTA_OSS_MODE=server', 'INSTA_OSS_VERSION=test', 'INSTA_OSS_TEMPLATES_DIR=/app/templates', 'INSTA_OSS_UI_DIST=/app/ui/dist', 'NODE_ENV=production']))
  expect(JSON.parse(docker(['image', 'inspect', IMAGE, '--format', '{{json .Config.Cmd}}']))).toEqual(['node', 'node_modules/tsx/dist/cli.mjs', 'src/main.ts'])
  const labels = JSON.parse(docker(['image', 'inspect', IMAGE, '--format', '{{json .Config.Labels}}'])) as Record<string, string>
  expect(labels['org.opencontainers.image.version']).toBe('test')
  expect(labels['org.opencontainers.image.source']).toBe('https://github.com/InsForge/instacloud-oss')
  expect(docker(['image', 'inspect', IMAGE, '--format', '{{json .Config.Healthcheck.Test}}'])).toContain('/healthz')
  // The buildx plugin must ship in the image: git push-to-deploy builds the pushed repo with BuildKit
  // (--secret + git context), which the legacy builder cannot do. v0.4.0 shipped WITHOUT it, so every
  // push-to-deploy build failed on the box, and the dev host's own buildx masked the gap in every
  // other test. `buildx version` needs no daemon, so this runs against the image alone.
  const bx = spawnSync('docker', ['run', '--rm', '--entrypoint', 'docker', IMAGE, 'buildx', 'version'], { encoding: 'utf8' })
  expect(bx.status, `docker buildx missing from the image:\n${bx.stdout}\n${bx.stderr}`).toBe(0)
  expect(bx.stdout).toMatch(/buildx/)
}, 900_000)

test('the image boots in local mode: /healthz, docker CLI over the socket, dashboard and templates on disk, the SPA shell', async () => {
  spawnSync('docker', ['rm', '-f', CONTAINER])
  // Linux: host networking, the way compose runs it (the daemon binds 127.0.0.1 and reaches container
  // IPs). Elsewhere (Docker Desktop) a bridge container with the port published on loopback; the daemon
  // then listens on 0.0.0.0 inside the container so the publish reaches it.
  const net = process.platform === 'linux'
    ? ['--network', 'host']
    : ['-p', `127.0.0.1:${PORT}:${PORT}`, '-e', 'INSTA_OSS_LISTEN_HOST=0.0.0.0']
  docker(['run', '-d', '--name', CONTAINER, ...net,
    '-e', 'INSTA_OSS_MODE=local', '-e', `INSTA_OSS_PORT=${PORT}`, '-e', `INSTA_OSS_DATA_DIR=${DATA}`, '-e', 'INSTA_OSS_SCHEDULER=0',
    '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', `${DATA}:${DATA}`, IMAGE])

  await waitFor('/healthz', async () => {
    const r = await fetch(`${BASE}/healthz`)
    return r.ok && (await r.json() as { ok: boolean }).ok === true
  }, 90_000)

  // the docker CLI copied from docker:<v>-cli talks to the host's daemon through the socket
  expect(docker(['exec', CONTAINER, 'docker', 'version', '--format', '{{.Server.Version}}']).trim()).toMatch(/^\d+\.\d+/)
  // dashboard and bundled templates at the paths the image ENV names
  expect(() => docker(['exec', CONTAINER, 'ls', '/app/ui/dist/index.html', '/app/templates/hermes/insta.template.yaml'])).not.toThrow()
  expect(() => docker(['exec', CONTAINER, 'ls', '/app/test'])).toThrow()          // .dockerignore keeps the context small
  expect(() => docker(['exec', CONTAINER, 'ls', '/app/node_modules/vitest'])).toThrow()  // --omit=dev

  // GET / on the daemon's own host serves the SPA shell with the mode flag the dashboard reads (WP1)
  const shell = await fetch(`${BASE}/`)
  expect(shell.status).toBe(200)
  expect(shell.headers.get('content-type')).toMatch(/text\/html/)
  const html = await shell.text()
  expect(html).toContain('<div id="root">')
  expect(html).toContain('window.__INSTA_OSS__')

  // the image's HEALTHCHECK (Host: api.<domain>) agrees with the daemon
  await waitFor('HEALTHCHECK healthy', async () => docker(['inspect', '-f', '{{.State.Health.Status}}', CONTAINER]).trim() === 'healthy', 120_000)
}, 300_000)
