import { spawn } from 'node:child_process'

/** Flags whose NEXT argument is a secret: `-e K=V` carries every credential a service runs with
 *  (DATABASE_URL, POSTGRES_PASSWORD, PGPASSWORD, the S3 keys), and `psql -tAc <sql>` carries the
 *  statement, which for `alter user postgres with password '...'` is the new password in clear. */
const SECRET_VALUE_FLAGS: ReadonlySet<string> = new Set(['-e', '--env', '-c', '-tAc', '-Atc', '--command'])
/** A DSN with an inline password, wherever it appears (a positional `pg_dump <url>`, an `--option=`). */
const DSN_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:/?#\s]+:)[^@\s]+@/g

const redactPair = (arg: string): string => {
  const eq = arg.indexOf('=')
  return eq === -1 ? '[redacted]' : `${arg.slice(0, eq)}=[redacted]`
}

/**
 * The argv as it may be shown to a human. A failed `docker create`/`exec` message is not only
 * logged: it becomes the 500 body of `POST /deploy`, and the template executor PERSISTS it on the
 * deployment row in state.json. Redaction here is what keeps a credential out of all three.
 */
export function redactDockerArgs(args: readonly string[]): string {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (SECRET_VALUE_FLAGS.has(a) && i + 1 < args.length) {
      out.push(a, redactPair(args[i + 1]))
      i++
      continue
    }
    if (a.startsWith('--env=')) { out.push(`--env=${redactPair(a.slice(6))}`); continue }
    out.push(a.replace(DSN_RE, '$1[redacted]@'))
  }
  return out.join(' ')
}

/** Hard ceiling on what one `docker` call may buffer in the daemon's heap. `docker logs --tail`
 *  is bounded by its line COUNT, never by their length, so one container writing a single huge
 *  line would otherwise be an out-of-memory lever on the whole daemon. */
export const DOCKER_MAX_OUTPUT_BYTES = 64 * 1024 * 1024
/** stderr is only ever quoted into an error message, so it needs far less room than stdout. */
const MAX_STDERR_BYTES = 64 * 1024

/** Run the `docker` CLI, capture stdout as a Buffer, feed optional stdin. Rejects on non-zero exit.
 *  `mergeStderr` folds stderr into the captured output — `docker logs` replays the container's own
 *  stderr stream there (Postgres logs entirely to stderr), which is data, not error noise. */
export function docker(args: string[], opts: { input?: Buffer; mergeStderr?: boolean; env?: Record<string, string> } = {}): Promise<Buffer> {
  return dockerCall(args, opts).done
}

/** One docker CLI invocation with a handle on the CHILD.
 *
 *  A caller that gives up on a docker call still has a process running, and that process can act
 *  after the caller has released whatever lock it held: a `stop` that lands late stops whatever
 *  holds the name by then, which after a deploy is the REPLACEMENT container. So the timeout
 *  wrapper needs more than a race against a promise -- it needs to end the command and to know
 *  that it ended. `kill()` is that, and `done` still settles only when the child has closed, so
 *  "this rejected" and "no command of ours is running" are the same moment. */
export function dockerCall(args: string[], opts: { input?: Buffer; mergeStderr?: boolean; env?: Record<string, string> } = {}): { done: Promise<Buffer>; kill: () => void } {
  let child: ReturnType<typeof spawn> | undefined
  const done = new Promise<Buffer>((resolve, reject) => {
    // `env` rides the CHILD's environment (merged over ours), for values that must reach docker
    // without appearing in its argv: `docker exec -e NAME` (no value) forwards it from there.
    const p = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}) })
    child = p
    const out: Buffer[] = []
    let outBytes = 0
    let overflowed = false
    let err = ''
    const keep = (d: Buffer): void => {
      if (overflowed) return
      if (outBytes + d.length > DOCKER_MAX_OUTPUT_BYTES) {
        overflowed = true
        p.kill('SIGKILL')
        return
      }
      out.push(d)
      outBytes += d.length
    }
    p.stdout.on('data', keep)
    p.stderr.on('data', (d: Buffer) => {
      if (opts.mergeStderr) keep(d)
      else if (err.length < MAX_STDERR_BYTES) err += d.toString()
    })
    p.on('error', reject)
    p.on('close', (code) => {
      if (overflowed) {
        reject(new Error(`docker ${redactDockerArgs(args)} -> output exceeded ${DOCKER_MAX_OUTPUT_BYTES} bytes`))
        return
      }
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new Error(`docker ${redactDockerArgs(args)} -> exit ${code}: ${err.trim()}`))
    })
    p.stdin.on('error', () => { /* the child exited before it read stdin (killed on overflow) */ })
    p.stdin.end(opts.input ?? undefined)
  })
  // SIGKILL, not SIGTERM: this is called when a bound has already expired, and a client that
  // negotiates its own shutdown is a client that can keep the caller waiting again. It is
  // idempotent and harmless on a child that has already exited.
  return { done, kill: () => { child?.kill('SIGKILL') } }
}

/** Docker's own "there is no such container", in both spellings the CLI uses: the client-side
 *  `Error: No such object: <name>` (Docker 27, measured) and dockerd's `No such container`. */
export const NO_SUCH_CONTAINER = /no such (?:object|container)/i

/**
 * Remove a container and answer only when it is GONE, or raise.
 *
 * The one piece of safety logic this codebase must not have two copies of. Every teardown above
 * it deletes bind-mounted data and drops the row that names it once this returns, so treating a
 * failed removal as an already-absent one erases the files a still-running container is writing.
 * Three ways, as everywhere else: dockerd saying there is no such container is absence; an
 * ambiguous error is re-checked with a probe; anything the probe cannot clear raises.
 *
 * The Postgres and managed adapters both used to carry this, regex and probe included, which is
 * exactly where a future fix lands in one copy and not the other.
 */
export async function destroyContainer(container: string, exec: DockerExec = docker): Promise<void> {
  try {
    await exec(['rm', '-f', '-v', container])
    return
  } catch (e) {
    if (NO_SUCH_CONTAINER.test(e instanceof Error ? e.message : String(e))) return
    try {
      await exec(['inspect', '-f', '{{.State.Status}}', container])
    } catch (probe) {
      // Only dockerd's own not-found clears it. A probe that could not answer says nothing.
      if (NO_SUCH_CONTAINER.test(probe instanceof Error ? probe.message : String(probe))) return
    }
    throw e
  }
}

/** The docker seam both adapters inject in tests: the CLI in production, a stub in a unit test. */
export type DockerExec = (args: string[], opts?: { input?: Buffer; mergeStderr?: boolean }) => Promise<Buffer>

/** A probe that could not answer at all: a daemon that is not talking, a template error, a
 *  permission failure. It is NOT `gone`, and no caller may read it as absence. Lives here, beside
 *  `destroyContainer` and `NO_SUCH_CONTAINER`, because it is the same one rule and this codebase
 *  has already paid twice for two copies of it. */
export const UNREADABLE = 'unreadable'

/** One `docker inspect -f`, CLASSIFIED three ways: the field's value, `null` when dockerd said
 *  there is no such object, and `UNREADABLE` when the probe failed for a reason that says nothing
 *  about the container. Collapsing the last two into `null` is the defect this constant exists to
 *  make impossible to write by accident. */
export async function inspectField(container: string, format: string, exec: DockerExec = docker): Promise<string | null> {
  try {
    return (await exec(['inspect', '-f', format, container])).toString().trim()
  } catch (e) {
    return NO_SUCH_CONTAINER.test(e instanceof Error ? e.message : String(e)) ? null : UNREADABLE
  }
}

/** Raised when a docker read could not answer and the caller has no safe way to carry on. The
 *  fork's fallback-to-stream deliberately does NOT catch it (an unanswered probe must never
 *  become "try the other copy method"), and the boot migration lets it out of the branch so the
 *  row stays unstamped and the next boot retries. */
export class UnreadableProbeError extends Error {}
