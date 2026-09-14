// Samples every container the daemon manages into MetricsHistory on a timer, and keeps that history
// across restarts in one file under the data dir. One `docker ps -a` and one `docker stats` per tick,
// like the scheduler's sweep. A container that exists but is not running is recorded as zero, which
// is how the cloud draws a stopped service: an asleep database reads as a flat line at 0, not a gap.

import { readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { dockerCall } from './docker'
import { statsToSamples, type ContainerSample, type MetricsHistory } from './metrics-history'

export const SAMPLE_INTERVAL_SEC = 30
export const PERSIST_INTERVAL_SEC = 300
const DOCKER_TIMEOUT_MS = 20_000
/** Every container the daemon creates is named `io-…` (names.ts); nothing else on the host is sampled. */
const MANAGED_PREFIX = 'io-'

export type DockerRead = (args: string[]) => Promise<Buffer>

/** A docker read that gives up, and kills the child, after DOCKER_TIMEOUT_MS: a hung `docker stats`
 *  must not hold every later tick behind it. */
export function boundedDockerRead(args: string[]): Promise<Buffer> {
  const call = dockerCall(args)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      call.kill()
      reject(new Error(`docker ${args[0]} timed out after ${DOCKER_TIMEOUT_MS} ms`))
    }, DOCKER_TIMEOUT_MS)
  })
  return Promise.race([call.done, timeout]).finally(() => clearTimeout(timer))
}

export class MetricsSampler {
  private timer: ReturnType<typeof setInterval> | undefined
  private inFlight: Promise<void> | undefined
  private started = false
  private lastPersist = 0
  private readonly docker: DockerRead
  private readonly now: () => number
  private readonly log: (message: string) => void

  constructor(readonly history: MetricsHistory, private readonly opts: {
    file: string
    docker?: DockerRead
    now?: () => number
    intervalSec?: number
    log?: (message: string) => void
  }) {
    this.docker = opts.docker ?? boundedDockerRead
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.log = opts.log ?? ((message) => console.warn(message))
  }

  /** Restore the saved history. A missing file is a first boot; an unreadable one is logged and
   *  started over, never fatal: history is for charts, not state the daemon runs on. Synchronous on
   *  purpose — it runs once, at boot, before the daemon serves anything. */
  load(): void {
    let text: string
    try {
      text = readFileSync(this.opts.file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`metrics history: could not read ${this.opts.file}: ${String(e)}`)
      return
    }
    try {
      this.history.load(JSON.parse(text), this.now())
    } catch (e) {
      this.log(`metrics history: ignoring unreadable ${this.opts.file}: ${String(e)}`)
    }
  }

  async sampleOnce(): Promise<void> {
    const t = this.now()
    const ps = (await this.docker(['ps', '-a', '--format', '{{.Names}}\t{{.State}}'])).toString()
    const rows: ContainerSample[] = []
    const running: string[] = []
    for (const line of ps.split('\n').filter(Boolean)) {
      const [name, state] = line.split('\t')
      if (!name?.startsWith(MANAGED_PREFIX)) continue
      if (state === 'running') running.push(name)
      else rows.push({ name, cpuCores: 0, memBytes: 0, rxBytes: 0, txBytes: 0 })
    }
    if (running.length) {
      try {
        rows.push(...statsToSamples((await this.docker(['stats', '--no-stream', '--format', '{{json .}}', ...running])).toString()))
      } catch (e) {
        // A container stopping between `ps` and `stats` fails the whole call; the next tick sees it stopped.
        this.log(`metrics history: docker stats failed: ${String(e)}`)
      }
    }
    this.history.record(t, rows)
    this.history.prune(t)
    if (t - this.lastPersist >= PERSIST_INTERVAL_SEC) await this.persist(t)
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.load()
    this.lastPersist = this.now()
    this.tick()
    this.timer = setInterval(() => this.tick(), (this.opts.intervalSec ?? SAMPLE_INTERVAL_SEC) * 1000)
    this.timer.unref?.()
  }

  /** Stop sampling, wait for a tick in progress, and save. A sampler never started saves nothing, so
   *  it cannot overwrite a saved history with an empty one. */
  async stop(): Promise<void> {
    if (!this.started) return
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.inFlight
    await this.persist(this.now())
    this.started = false
  }

  private tick(): void {
    if (this.inFlight) return // the previous tick is still waiting on docker, or on its save
    this.inFlight = this.sampleOnce()
      .catch((e) => this.log(`metrics history: sample failed: ${String(e)}`))
      .finally(() => { this.inFlight = undefined })
  }

  /** Write-then-rename, owner-only, like state.json: a crash mid-write leaves the previous file. The
   *  file I/O is asynchronous so a multi-megabyte write does not hold the event loop the API and the
   *  router share; only the in-memory serialization is synchronous. Saves never overlap: every
   *  caller is either a tick (one at a time) or stop(), which waits for the tick first. */
  private async persist(t: number): Promise<void> {
    const tmp = `${this.opts.file}.${process.pid}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(this.history.toJSON()), { mode: 0o600 })
      await rename(tmp, this.opts.file)
      this.lastPersist = t
    } catch (e) {
      this.log(`metrics history: could not save ${this.opts.file}: ${String(e)}`)
    }
  }
}
