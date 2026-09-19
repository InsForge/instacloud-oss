// One Postgres container per branch database, its PGDATA on a bind mount under the data dir
// (contract 00 section 12). Handles are container names the engine passes in (`io-<ref>-pg-<name>`,
// decision 17) and are never derived here.
//
// Three things this file exists to get right:
//   - a branch fork is a FILE-LEVEL clone of a source NOTHING IS WRITING: reflink the stopped
//     source's directory (sub-second at any size), start a container on the copy and let crash
//     recovery finish the job. A RUNNING source is streamed with `pg_basebackup` instead, because a
//     file-by-file walk of a live data directory assembles the destination out of several different
//     filesystem moments and is not crash-consistent (see `forkByReflink`). A filesystem without
//     reflinks streams the same way, and the daemon never buffers a byte on either path
//     (04 section D);
//   - readiness is TCP, not the socket: the image's init-time temporary server listens on the unix
//     socket only, so a socket-only probe answers "ready" mid-initdb and the next statement dies
//     with `server closed the connection unexpectedly` (#34, decision 34);
//   - the password is minted per instance (decision 18): a lane on a public interface must never
//     carry a constant.
import { randomBytes } from 'node:crypto'
import { docker, destroyContainer, inspectField, UNREADABLE, UnreadableProbeError } from '../docker'
import { forkMethod, probedCapabilities, sharedDataDir } from '../datadir'
import { loadConfig } from '../config'
import { NoReflinkError } from '../types'
import type { Config } from '../config'
import type { DataDirOps, DatabaseAdapter, PgTarget, ServiceLimits } from '../types'

const DB = 'app'
const IMAGE = 'postgres:16-alpine'
const PGDATA = '/var/lib/postgresql/data'
const HBA_LINE = 'host replication all all scram-sha-256  # insta-oss basebackup'
const READY_TIMEOUT_MS = 120_000
const QUERY_DEADLINE_MS = 30_000

/** psql stderr that means "the server is not accepting connections YET", not "the query is wrong". */
const CONNECT_PHASE = [
  'server closed the connection unexpectedly',
  'Connection refused',
  'the database system is starting up',
  'is not currently accepting connections',
]
/** `docker logs` lines that mean the copy did not come out recoverable: retry, then fall back. The
 *  running-source rule below is the actual defence; this is the last net under it, for a source that
 *  was already damaged (an interrupted earlier copy, a half-written directory). It cannot be the
 *  first one: it catches only the copies that fail LOUDLY, and a torn copy that boots anyway is the
 *  worse outcome. */
const TORN_COPY = /could not locate a valid checkpoint record|invalid checkpoint record|requested WAL segment .* has already been removed|database files are incompatible/

type ProvisionOpts = {
  publishLoopback?: boolean
  limits?: ServiceLimits
  /** Whether a container name (or data directory) still belongs to a live branch row. Absent means
   *  "nothing references it": the engine only provisions or forks onto a service it is creating, so
   *  anything already sitting there is an interrupted earlier attempt. */
  referenced?: (container: string) => boolean
}
type ForkOpts = ProvisionOpts & { ensureSourceRunning?: () => Promise<void> }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The docker seam, the way `Scheduler` takes a `Runtime`: production is the docker CLI in
 *  `src/docker.ts`, and a test injects a stub so this adapter has coverage without a container. */
export type DockerExec = (args: string[], opts?: { input?: Buffer; mergeStderr?: boolean }) => Promise<Buffer>

export class LocalPostgres implements DatabaseAdapter {
  private readonly cfg: Config
  private readonly data: DataDirOps
  private readonly exec: DockerExec
  constructor(opts: { cfg?: Config; data?: DataDirOps; docker?: DockerExec } = {}) {
    this.cfg = opts.cfg ?? loadConfig()
    this.data = opts.data ?? sharedDataDir(this.cfg)
    this.exec = opts.docker ?? docker
  }

  async provision(t: PgTarget, opts: ProvisionOpts = {}): Promise<{ url: string }> {
    await this.clearOrphan(t, opts)
    if (t.dataDir) {
      if (!(await this.data.isEmptyOrMissing(t.dataDir))) {
        throw new Error(`data directory ${t.dataDir} is not empty; refusing to initdb over an existing database`)
      }
      await this.data.ensureDir(t.dataDir, 0o700)
    }
    const password = randomBytes(24).toString('base64url')
    await this.run(t, opts, [
      '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${DB}`,
    ])
    await this.waitReady(t.container)
    return { url: `postgres://postgres:${password}@${t.container}:5432/${DB}` }
  }

  /** Fork = reflink clone of a source that is NOT RUNNING, else `pg_basebackup`. The clone inherits
   *  the source's files and therefore its password, so the returned DSN is the source's with the
   *  host swapped (decision 18).
   *
   *  Why the running source streams: `clonePostgres` walks the data directory file by file, and a
   *  live postmaster keeps writing all the way through it (its own checkpoints, heap and index
   *  writes, relation files created and unlinked, WAL segments recycled). The destination is then
   *  assembled from several different moments of the source's filesystem, which is a torn copy, not
   *  a crash-consistent one, and Postgres's own filesystem-backup rules say as much: a file-level
   *  copy is valid only against a stopped server, a genuinely atomic filesystem snapshot, or
   *  `pg_backup_start`/`pg_backup_stop` with every WAL segment retained. `CHECKPOINT` freezes
   *  nothing, and a copy that boots anyway is the dangerous outcome, so this decides BEFORE the
   *  walk and not from the destination's logs afterwards.
   *
   *  This costs the fast path almost nothing: databases here sleep (decision 12 and the whole
   *  scheduler), so the parent of a branch is stopped most of the time, and a stopped container
   *  has no writer at all. Its directory is exactly the `kill -9` state Postgres recovers from
   *  through WAL, and because nothing changes during the walk the copy is one moment of it. What
   *  proves nothing changed is the source's run fingerprint (`RUN_FMT`) read before and after the
   *  walk: a status re-read alone cannot see a container that started and stopped again inside
   *  the window, and a paused source cannot be shown to have stayed frozen at all, so it streams. */
  async fork(src: PgTarget & { url: string }, dst: PgTarget, opts: ForkOpts = {}): Promise<{ url: string; method: 'reflink' | 'basebackup'; ms: number }> {
    const t0 = Date.now()
    const method = forkMethod(this.cfg, probedCapabilities())
    if (method === 'reflink' && src.dataDir && dst.dataDir) {
      try {
        const ms = await this.forkByReflink(src, dst, opts, false)
        return { url: swapHost(src.url, dst.container), method: 'reflink', ms }
      } catch (e) {
        // Only these three fall back to the stream. Anything else -- an `UnreadableProbeError`
        // from the orphan sweep above all, since it means the destination could not be cleared --
        // fails the fork here rather than trying the other copy method against it.
        if (!(e instanceof NoReflinkError) && !(e instanceof TornCopyError) && !(e instanceof RunningSourceError)) throw e
        // `INSTA_OSS_FORK=reflink` is the operator asking to FAIL rather than copy, which is how
        // main.ts already reads it at boot when the probe says this data dir cannot clone. The
        // probe is not the last word, though: a clone can still turn out impossible (a dst on
        // another mount, a `cp -c` that exits non-zero), and falling through there would stream a
        // pg_basebackup behind their back, which is the one thing the strict setting forbids.
        if (this.cfg.data.fork === 'reflink') {
          throw new NoReflinkError(`INSTA_OSS_FORK=reflink: cannot clone ${src.container} into ${dst.dataDir} by reflink (${firstLine(e)}); refusing to fall back to pg_basebackup`)
        }
        // NoReflinkError: this filesystem cannot clone after all. RunningSourceError: the source is
        // live, so a file-level copy of it would not be crash-consistent. TornCopyError: the copy
        // did not recover twice. All three fall through to the stream.
      }
    }
    await this.forkByBasebackup(src, dst, opts)
    return { url: swapHost(src.url, dst.container), method: 'basebackup', ms: Date.now() - t0 }
  }

  async query(container: string, sql: string, opts: { statementTimeoutMs?: number } = {}): Promise<string> {
    const deadline = Date.now() + QUERY_DEADLINE_MS
    // A per-statement bound through the server's own option (PGOPTIONS), so an ad-hoc statement
    // cannot hold the request and the docker child open indefinitely.
    const timeout = opts.statementTimeoutMs
      ? ['-e', `PGOPTIONS=-c statement_timeout=${Math.trunc(opts.statementTimeoutMs)}`] : []
    for (;;) {
      try {
        // The SQL rides STDIN, not argv: `-tAc <sql>` sat in the host's process listing for the
        // life of the exec (redaction only covered error MESSAGES). `-X` skips psqlrc; `-f -`
        // does process psql meta-commands and :variables, which internal SQL never contains and
        // which grant an ad-hoc author nothing beyond the superuser SQL they already hold.
        const out = await this.exec(['exec', '-i', ...timeout, container, 'psql', '-X', '-U', 'postgres', '-d', DB,
          '-v', 'ON_ERROR_STOP=1', '-tA', '-f', '-'], { input: Buffer.from(sql) })
        return out.toString().trim()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (Date.now() >= deadline || !CONNECT_PHASE.some((m) => msg.includes(m))) throw e
        await sleep(500)
      }
    }
  }

  /** Container only, with its anonymous volumes (`-v`): the engine removes the data directory.
   *
   *  A removal that FAILED is not the same as one that had nothing to remove, and swallowing
   *  both destroys the evidence the caller needs: the engine deletes a bind-mounted PGDATA
   *  after this returns, and doing that under a container docker refused to remove erases the
   *  files a live Postgres is still writing. Absence is therefore established the same three
   *  ways as everywhere else in this adapter: dockerd saying there is no such container is
   *  absence, anything else is not, and the caller is told. */
  async destroy(container: string): Promise<void> {
    return destroyContainer(container, this.exec)
  }

  async rename(container: string, to: string): Promise<void> {
    await this.exec(['rename', container, to])
  }

  // ---- internals ----

  private run(t: PgTarget, opts: ProvisionOpts, env: string[]): Promise<void> { return pgRun(t, opts, env, this.exec) }

  /** An interrupted provision or fork leaves a container of the right name, or a half-written data
   *  directory, behind. Both are removed before a retry (a `branch create feat` after a daemon crash
   *  mid-fork must not fail with `name already in use`, nor clone over a partial copy). Anything a
   *  live branch row still references is left alone. */
  private async clearOrphan(t: PgTarget, opts: ProvisionOpts): Promise<void> {
    if (opts.referenced?.(t.container)) return
    // This function DELETES a Postgres data directory, so it runs only on evidence. The evidence
    // is docker's answer about the container of that name, and a probe that could not answer is
    // not evidence of anything: `unreadable` means the daemon is not talking, or the inspect
    // failed for a reason that says nothing about what is there. `referenced` cannot carry the
    // whole weight here -- it is absent on every path where the caller believes it is creating
    // the service -- so an unanswered probe aborts the sweep before the container removal AND
    // before the bytes. What follows is then a create that fails on a non-empty directory or a
    // name already in use, which is a loud, recoverable outcome; deleting a live branch's
    // database because docker hiccuped is neither.
    const status = await containerStatus(t.container, this.exec)
    if (status === UNREADABLE) {
      // THROWS, rather than returning. A return reads as "the sweep is done, carry on", and the
      // callers act on that: `forkByReflink` would clone into a destination nobody cleared,
      // which can merge a fresh copy into an interrupted attempt's bytes, and
      // `forkByBasebackup` would go on to remove that destination if the stream failed. The
      // operation has to stop instead, and the error is its OWN class so the fork's
      // fallback-to-stream catch rethrows it: an unanswered probe must never become "try the
      // other copy method".
      throw new UnreadableProbeError(`cannot tell whether ${t.container} is an orphan of an interrupted attempt: docker could not report its state, so ${t.dataDir ?? 'the destination'} is left untouched and this operation stops`)
    }
    if (status !== null) {
      console.warn(`removing orphan from an interrupted fork: container ${t.container}`)
      await this.exec(['rm', '-f', '-v', t.container]).catch(() => { /* raced away */ })
    }
    if (t.dataDir && !(await this.data.isEmptyOrMissing(t.dataDir))) {
      console.warn(`removing orphan from an interrupted fork: ${t.dataDir}`)
      await this.data.remove(t.dataDir)
    }
  }

  /** The reflink path, for a source with no writer. Throws RunningSourceError when the source is
   *  live, NoReflinkError when the filesystem cannot clone, and TornCopyError when even a retried
   *  clone came out unrecoverable; the caller streams a basebackup for all three. */
  private async forkByReflink(src: PgTarget & { url: string }, dst: PgTarget, opts: ForkOpts, isRetry: boolean): Promise<number> {
    // The leftovers of an interrupted earlier attempt go first, before the source is judged. They
    // belong to no live branch row (that is what `referenced` checks, inside `clearOrphan`), so
    // they are this operation's to clear whichever way the judgement goes -- and when the strict
    // setting REFUSES on a live source there is no stream afterwards to clear them instead, so a
    // half-started container and a half-written directory would be stranded with nothing left
    // that names them. Clearing is confined to the destination; the source is untouched either
    // way, so a live source still costs its own side nothing.
    await this.clearOrphan(dst, opts)
    const before = await runFingerprint(src.container, this.exec)
    if (before === UNREADABLE) {
      throw new RunningSourceError(`docker could not report the state of ${src.container}, so it cannot be shown to be at rest`)
    }
    if (!atRest(before)) throw new RunningSourceError(sourceIsLive(src.container, stateOf(before)))
    const t0 = Date.now()
    await this.data.clonePostgres(src.dataDir, dst.dataDir)
    // The belt for the gap between the two: nothing in this daemon can start the source while a
    // fork holds its ServiceKey (decision 52 -- a traffic wake, a lifecycle start and a management
    // query all take that lock and queue behind this operation), but a `docker start` from outside
    // is not covered by any lock we hold. What has to be detected is any RUN that happened during
    // the walk, not just one that is still going: a start followed by a stop leaves the container
    // `exited` again, so the status on its own reads the same before and after while Postgres
    // wrote through the whole copy. The run timestamps are what move, so the whole fingerprint is
    // compared and any difference throws the copy away rather than starting it and trusting it.
    const after = await runFingerprint(src.container, this.exec)
    if (after !== before) {
      await this.data.remove(dst.dataDir).catch(() => {})
      throw new RunningSourceError(`${src.container} ran while its data directory was being cloned (${before ?? 'gone'} -> ${after ?? 'gone'}); the copy spans a write`)
    }
    await this.run(dst, opts, [])
    try {
      await this.waitReady(dst.container)
    } catch (e) {
      const logs = await this.exec(['logs', '--tail', '200', dst.container], { mergeStderr: true })
        .then((b) => b.toString()).catch(() => '')
      await this.exec(['rm', '-f', '-v', dst.container]).catch(() => {})
      await this.data.remove(dst.dataDir).catch(() => {})
      if (!TORN_COPY.test(logs)) throw e
      if (isRetry) throw new TornCopyError(`clone of ${src.container} did not recover: ${firstLine(e)}`)
      console.warn(`clone of ${src.container} did not recover; retrying the reflink copy once`)
      return this.forkByReflink(src, dst, opts, true)
    }
    return Date.now() - t0
  }

  /** The stream path: `pg_basebackup` inside a throwaway container on the branch network, writing
   *  straight into the destination's bind mount. Needs a RUNNING source, so a sleeping one is woken
   *  through the door the engine handed us. */
  private async forkByBasebackup(src: PgTarget & { url: string }, dst: PgTarget, opts: ForkOpts): Promise<void> {
    await this.clearOrphan(dst, opts)
    await opts.ensureSourceRunning?.()
    // A source at rest is the ORDINARY state of a branch's parent here, and this path is where a
    // box without reflinks sends every fork, so the stream meets a stopped container constantly.
    // The door is how it comes up: the engine hands one in (`wake`, decision 52), and starting the
    // container from inside the adapter instead would move a container behind the scheduler's
    // back. Without a door there is nothing to wait for, and `waitReady` on a stopped container
    // reports `exited before it became ready`, which reads like a broken database rather than a
    // caller that skipped the wake.
    // Every state but a live server fails HERE, naming itself, rather than in a readiness poll.
    // `paused` is the one that makes this more than a nicety: a frozen postmaster answers no
    // probe and never exits, so `waitReady` would poll it for the full two-minute window and
    // then report a readiness timeout on a container that was never going to answer. Only
    // `restarting` is worth waiting on, since docker is already bringing it back, so that one
    // falls through.
    const status = await containerStatus(src.container, this.exec)
    if (status !== 'running' && status !== 'restarting') {
      throw new Error(`pg_basebackup needs the source running: ${src.container} is ${status ?? 'gone'}`
        + (opts.ensureSourceRunning ? ' after its wake door was opened' : ' and the caller passed no wake door'))
    }
    await this.waitReady(src.container)
    await this.ensureHba(src.container)
    if (dst.dataDir) await this.data.ensureDir(dst.dataDir, 0o700)
    try {
      await this.exec(['run', '--rm', '--network', src.network,
        '-v', `${dst.dataDir}:/out`,
        '-e', `PGPASSWORD=${passwordOf(src.url)}`,
        IMAGE, 'pg_basebackup', '-h', src.container, '-p', '5432', '-U', 'postgres', '-D', '/out',
        '-X', 'stream', '--checkpoint=fast', '--no-password'])
    } catch (e) {
      if (dst.dataDir) await this.data.remove(dst.dataDir).catch(() => {})
      throw new Error(`pg_basebackup failed: ${firstLine(e)}`)
    }
    // A base backup copies pg_hba.conf, so the child arrives carrying the source's replication
    // line. Appending that line only on a source is worth nothing if every child inherits it and
    // then passes it on again, so strip it from the copy BEFORE the child ever starts: a branch
    // that is never a basebackup source should not accept a replication connection at all. This
    // runs in a throwaway container for the same reason the backup did, since the directory it
    // just wrote is owned by the image's uid and an unprivileged daemon cannot edit it.
    if (dst.dataDir) {
      await this.exec(['run', '--rm', '-v', `${dst.dataDir}:/out`, IMAGE,
        'sed', '-i', `/insta-oss basebackup/d`, '/out/pg_hba.conf'])
    }
    await this.run(dst, opts, [])
    await this.waitReady(dst.container)
  }

  private waitReady(container: string, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    return pgWaitReady(container, timeoutMs, this.exec)
  }

  /** `pg_basebackup` authenticates as a replication connection, which the stock image's pg_hba.conf
   *  does not allow from another container. Appended once, idempotently, after readiness, and ONLY
   *  to a database that is about to be a basebackup source. It is password gated, so it is not an
   *  escalation, but in server mode the database lane publishes on every interface, and a database
   *  that will never be a source has no reason to let a leaked password become a physical replica. */
  private async ensureHba(container: string): Promise<void> {
    await pgAppendHba(container, this.exec)
    await this.query(container, 'select pg_reload_conf()')
  }
}

/** Raised when a reflink clone came out unrecoverable twice; the caller streams instead. */
class TornCopyError extends Error {}

/** Raised when the source is live: a file-level copy of it cannot be crash-consistent, so the fork
 *  streams instead (and `INSTA_OSS_FORK=reflink` refuses rather than producing a torn copy). */
class RunningSourceError extends Error {}

const sourceIsLive = (container: string, state: string): string =>
  `${container} is ${state}: a file-level clone of a live Postgres data directory is not crash-consistent`

/** `docker run` for a provision, a clone start, or the boot migration's re-create under the new
 *  container name. `--mount type=bind`, never `-v` (decision 56): with `-v` dockerd CREATES a
 *  missing host directory, so after a reboot where the data volume did not mount, its own
 *  `--restart unless-stopped` would run initdb on the root filesystem. With `--mount` the start
 *  fails instead. Never `--stop-signal`: the image's STOPSIGNAL is SIGINT, which is Postgres's fast
 *  shutdown (SIGTERM would be a smart shutdown that waits for clients). A non-empty bind source
 *  skips initdb, so the existing password and configuration travel with the files. */
export async function pgRun(t: PgTarget, opts: { publishLoopback?: boolean; limits?: ServiceLimits } = {}, env: string[] = [], exec: DockerExec = docker): Promise<void> {
  await exec(['run', '-d', '--restart', 'unless-stopped', '--name', t.container, '--network', t.network,
    ...env,
    // ---- args WP2 ----
    ...(opts.publishLoopback ? ['-p', '127.0.0.1::5432'] : []),
    // ---- args WP3 ----
    ...limitArgs(opts.limits),
    // ---- args WP4 ----
    ...(t.dataDir ? ['--mount', `type=bind,src=${t.dataDir},dst=${PGDATA}`] : []),
    IMAGE, '-c', 'shared_preload_libraries=pg_stat_statements'])
}

/** TCP readiness (#34): `pg_isready` over 127.0.0.1 AND one statement that must come back. The
 *  image's initdb phase runs a temporary server on the unix socket only, so this is the one probe
 *  that cannot answer "ready" too early. A container that exits ends the wait with its own logs. */
export async function pgWaitReady(container: string, timeoutMs = READY_TIMEOUT_MS, exec: DockerExec = docker): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    try {
      await exec(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', DB])
      const out = (await exec(['exec', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', DB,
        '-tAc', 'select 1'])).toString().trim()
      // Only the row a live server sends back counts. An empty capture is NOT ready: this predicate
      // exists because the image's initdb phase runs a temporary server on the unix socket while
      // the real one is still starting (#34), and "nothing came back" is exactly what that phase
      // looks like. Tests inject the `exec` seam instead of widening the production check.
      if (out.split('\n')[0].trim() === '1') return
      last = `select 1 answered ${JSON.stringify(out)}`
    } catch (e) {
      last = firstLine(e)
    }
    // A container dockerd cannot report on does NOT end the wait: `containerStatus` answers
    // `unreadable` there, which is neither exited nor gone, so the poll keeps going to its
    // deadline instead of blaming a container that may be perfectly healthy.
    const status = await containerStatus(container, exec)
    if (status === 'exited' || status === 'dead' || status === null) {
      const logs = await exec(['logs', '--tail', '40', container], { mergeStderr: true })
        .then((b) => b.toString().trim()).catch(() => '')
      throw new Error(`postgres "${container}" ${status === null ? 'is gone' : 'exited'} before it became ready: ${last}\n${logs}`)
    }
    if (Date.now() >= deadline) throw new Error(`postgres "${container}" never became ready: ${last}`)
    await sleep(500)
  }
}

/** The replication line `pg_basebackup` needs, appended once. The caller reloads the config. */
export async function pgAppendHba(container: string, exec: DockerExec = docker): Promise<void> {
  const conf = `${PGDATA}/pg_hba.conf`
  await exec(['exec', container, 'sh', '-c',
    `grep -q 'insta-oss basebackup' ${conf} || echo '${HBA_LINE}' >> ${conf}`])
}

function limitArgs(limits?: ServiceLimits): string[] {
  if (!limits) return []
  return ['--cpus', String(limits.cpu), '--memory', `${limits.memoryMb}m`, '--memory-swap', `${limits.memoryMb}m`]
}

function containerStatus(container: string, exec: DockerExec = docker): Promise<string | null> {
  return inspectField(container, '{{.State.Status}}', exec)
}

/** One RUN of a container, as `docker inspect` reports it: the status plus the two timestamps
 *  docker stamps when a run begins and ends. Measured on Docker 27 (`docker inspect -f` on a
 *  container taken through the whole cycle): a stop moves `FinishedAt`, the next start moves
 *  `StartedAt`, and a restart moves both, so a start-and-stop pair that happens between two reads
 *  is visible even though the status is `exited` on both of them. A pause and unpause moves
 *  NOTHING -- not the status once it is paused again, not either timestamp, not even `.State.Pid`
 *  -- which is why `paused` is refused up front instead of being fingerprinted. */
const RUN_FMT = '{{.State.Status}}|{{.State.StartedAt}}|{{.State.FinishedAt}}'

/** The container states with no process inside: the only ones whose data directory may be walked
 *  file by file. `running` is a writer. `paused` is a live postmaster with its processes frozen,
 *  and an unpause and re-pause inside the walk leaves every inspect field identical, so a paused
 *  source cannot be shown to have stayed still and is streamed instead. `restarting` and `dead`
 *  are not at rest either. A container that does not exist has no writer and is at rest: an
 *  already-removed source with its bytes still on disk is a clone this adapter may make. */
const AT_REST = new Set(['exited', 'created'])

function runFingerprint(container: string, exec: DockerExec = docker): Promise<string | null> {
  return inspectField(container, RUN_FMT, exec)
}

const stateOf = (fingerprint: string | null): string => (fingerprint === null ? 'gone' : fingerprint.split('|')[0])
/** A container with no writer: dockerd says it is stopped, or dockerd says it is not there at
 *  all. A probe that could not answer is neither, so it is not at rest. */
const atRest = (fingerprint: string | null): boolean =>
  fingerprint === null || (fingerprint !== UNREADABLE && AT_REST.has(stateOf(fingerprint)))

/** The clone's DSN is the source's with the host swapped: a file-level fork inherits the source's
 *  roles and passwords (decision 18). */
export function swapHost(url: string, container: string): string {
  const at = url.lastIndexOf('@')
  if (at === -1) return url
  const rest = url.slice(at + 1)
  const slash = rest.indexOf('/')
  const tail = slash === -1 ? '' : rest.slice(slash)
  return `${url.slice(0, at + 1)}${container}:5432${tail}`
}

function passwordOf(url: string): string {
  const m = /^[a-zA-Z0-9+.-]+:\/\/[^:/@]*:([^@]*)@/.exec(url)
  return m ? decodeURIComponent(m[1]) : ''
}

function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.split('\n')[0].trim()
}
