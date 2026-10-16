// The data directory: one HOST path (`cfg.dataDir`, mounted at the same path inside the daemon
// container in server mode) holding every byte a branch owns, laid out by IMMUTABLE ids so a rename
// never detaches data (contract 00 section 12, decision 16):
//
//   pg/<ref>/<dataId>            PGDATA bind mount            0700
//   vol/<ref>/<volId>            compute /data bind mount      0777 (a user image may run as any uid)
//   md/<ref>/<prefix>-<dataId>   managed database data         0700
//
// Copies go through `src/fsclone.cjs`, run three ways (decision 23): the `ficlone` engine as a child
// of a root Linux daemon, `/bin/cp -c -a` (clonefile) on macOS, and the same program streamed to
// `node -` in the `node:22-alpine` helper container when an unprivileged Linux daemon hits EACCES on
// a PGDATA the postgres image chowned to its own uid. EVERY verb has the helper fallback, including
// the two predicates behind the provision and start guards.
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, chmodSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { docker } from './docker'
import { loadConfig } from './config'
import { MANAGED_DB } from './manageddb'
import { NoReflinkError } from './types'
import type { Config } from './config'
import type { DataDirOps, ManagedDbType } from './types'

const execFileP = promisify(execFile)

export type CopyEngine = 'inprocess' | 'helper' | 'cp-c'
export interface DataCapabilities { dataDir: string; reflink: boolean; engine: CopyEngine; warning?: string }

/** `fsclone.cjs` exit code for "this filesystem cannot reflink and the caller asked for always". */
const EXIT_NO_REFLINK = 75
/** `fsclone.cjs` exit code for "this process cannot read those bytes" (EACCES or EPERM).
 *
 *  It needs a code of its own because `runLocal` runs the program as a CHILD PROCESS and a
 *  promisified `execFile` rejection carries the child's exit STATUS in `e.code`, never the child's
 *  errno. With the child exiting 1, `errnoOf` answered "1", `HELPER_CODES` did not match, and the
 *  helper fallback below -- the entire answer to an unprivileged Linux daemon meeting a PGDATA the
 *  postgres image chowned 0700 to its own uid -- was unreachable: on the ordinary `npm run dev`
 *  laptop path a branch create failed outright instead of falling through to `pg_basebackup`. */
const EXIT_DENIED = 77
/** Errno answers that mean "no reflink here", not "the copy is broken" (decision 23). */
const NO_REFLINK_CODES = ['ENOSYS', 'ENOTSUP', 'EXDEV', 'EINVAL', 'EOPNOTSUPP']
/** Errno answers that mean "this daemon cannot read those bytes; run the verb in the helper". */
const HELPER_CODES = ['EACCES', 'EPERM']

const scriptPath = (): string => fileURLToPath(new URL('./fsclone.cjs', import.meta.url))

const errnoOf = (e: unknown): string => (e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '')

/** The synchronous ensure the engine's `volumeMount` needs: its contract signature is sync (it feeds
 *  a `docker create` argument), and `--mount type=bind` fails on a missing source, so the directory
 *  cannot be created lazily. */
export function ensureDirSync(path: string, mode: number): void {
  mkdirSync(path, { recursive: true, mode })
  try { chmodSync(path, mode) } catch { /* a directory the image's user owns keeps its own mode */ }
}

/** Pure path arithmetic over one data dir, shared by the engine's `layout()` hook. */
export function dataLayout(dataDir: string): {
  pg(ref: string, dataId: string): string
  vol(ref: string, volId: string): string
  md(ref: string, type: ManagedDbType, dataId: string): string
  branchRoots(ref: string): string[]
} {
  return {
    pg: (ref, dataId) => join(dataDir, 'pg', ref, dataId),
    vol: (ref, volId) => join(dataDir, 'vol', ref, volId),
    md: (ref, type, dataId) => join(dataDir, 'md', ref, `${MANAGED_DB[type].idPrefix}-${dataId}`),
    branchRoots: (ref) => [join(dataDir, 'pg', ref), join(dataDir, 'vol', ref), join(dataDir, 'md', ref)],
  }
}

export class DataDir implements DataDirOps {
  private caps: DataCapabilities | undefined
  constructor(private cfg: Config) {}

  /** Nothing runs at construction (contract 00 section 7): `main.ts` calls `probe()` at boot. */
  layout(): ReturnType<typeof dataLayout> { return dataLayout(this.cfg.dataDir) }

  /** What the boot probe found. Available after `probe()`; before it, a conservative "no reflink". */
  capabilities(): DataCapabilities {
    return this.caps ?? { dataDir: this.cfg.dataDir, reflink: false, engine: this.engine() }
  }

  private engine(): CopyEngine {
    if (process.platform === 'darwin') return 'cp-c'
    return process.getuid?.() === 0 ? 'inprocess' : 'helper'
  }

  /** Boot probe. The ONLY fatal outcome is an unwritable data dir: any failed clone attempt, listed
   *  errno or not, degrades to `reflink: false` plus one warning and the daemon boots (decision 23). */
  async probe(): Promise<DataCapabilities> {
    const dataDir = this.cfg.dataDir
    const scratch = join(dataDir, '.probe')
    // fatal: no data dir, no daemon
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    mkdirSync(scratch, { recursive: true, mode: 0o700 })
    const engine = this.engine()
    let reflink = false
    let reason = ''
    try {
      const out = await this.runVerb(['probe', scratch], { engine, helperOnly: engine === 'helper' })
      const parsed = out as { reflink?: boolean; code?: string }
      reflink = parsed.reflink === true
      if (!reflink) reason = parsed.code ?? 'unsupported'
    } catch (e) {
      reflink = false
      reason = errnoOf(e) || (e instanceof Error ? e.message.split('\n')[0] : String(e))
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
    this.caps = reflink
      ? { dataDir, reflink, engine }
      : {
        dataDir, reflink, engine,
        warning: `reflink probe failed on ${dataDir} (${reason}): branch forks stream pg_basebackup and volume forks copy`,
      }
    return this.caps
  }

  async ensureDir(path: string, mode: number): Promise<void> {
    mkdirSync(path, { recursive: true, mode })
    try { chmodSync(path, mode) } catch { /* a directory the image's user owns keeps its own mode */ }
  }

  /** Ordered PGDATA clone (pg_control snapshot first, pg_wal last, runtime scratch scrubbed).
   *  `--reflink=always`, so a filesystem without reflinks raises NoReflinkError and the caller falls
   *  back to `pg_basebackup` instead of silently byte-copying a live data directory. */
  async clonePostgres(src: string, dst: string): Promise<{ method: 'reflink'; ms: number }> {
    const out = await this.clone(src, dst, ['--pg', '--reflink=always']) as { ms?: number }
    return { method: 'reflink', ms: out.ms ?? 0 }
  }

  /** A compute /data tree. `--reflink=auto`, so a degraded box reports `method: 'copy'` instead of
   *  failing a branch create. */
  async cloneTree(src: string, dst: string): Promise<{ method: 'reflink' | 'copy'; ms: number }> {
    const out = await this.clone(src, dst, ['--reflink=auto']) as { ms?: number; method?: string }
    return { method: out.method === 'reflink' ? 'reflink' : 'copy', ms: out.ms ?? 0 }
  }

  private async clone(src: string, dst: string, flags: string[]): Promise<unknown> {
    const engine = this.engine()
    const argv = ['clone', src, dst, ...flags, `--engine=${engine === 'cp-c' ? 'cp-c' : 'ficlone'}`]
    return this.runVerb(argv, { engine })
  }

  /** `rm -rf`, refusing anything outside the data dir: this method is called from teardown paths
   *  with paths built from state, and a state row with an empty ref must never delete `/`. */
  async remove(path: string): Promise<void> {
    if (!path) return
    const target = this.inside(path, 'remove')
    try {
      rmSync(target, { recursive: true, force: true })
    } catch (e) {
      if (!HELPER_CODES.includes(errnoOf(e))) throw e
      await this.runHelper(['rm', target])
    }
  }

  /** Promote a staged directory to its final path in ONE step. The boot migration copies into a
   *  sibling staging directory and calls this last, so a destination that EXISTS is a destination
   *  that is whole: a daemon killed mid-copy leaves only the staging path behind and the next boot
   *  recopies from a source it never removed (04 section F). Both ends are inside the data dir, so
   *  this is a same-filesystem `rename(2)`. */
  async rename(src: string, dst: string): Promise<void> {
    const from = this.inside(src, 'rename')
    const to = this.inside(dst, 'rename')
    try {
      renameSync(from, to)
    } catch (e) {
      if (!HELPER_CODES.includes(errnoOf(e))) throw e
      await this.runHelper(['mv', from, to])
    }
  }

  /** A path this instance is allowed to destroy or move, resolved. Teardown and migration paths are
   *  built from state, and a row with an empty ref must never name `/`.
   *
   *  The lexical test is not enough on its own. `resolve()` only collapses `..` in the STRING, so a
   *  path that spells out something under the data dir can still land anywhere on the box the
   *  moment one of its components is a symlink: `rmSync` and `renameSync` both follow directory
   *  symlinks, and the boot migration's promotion is a rename INTO a path built from state. A
   *  `vol/<ref>` that someone (or an earlier restore, or an unpacked archive) left as a link to
   *  `/etc` would have had the staged copy promoted straight over it. So every component from the
   *  data dir down is checked with `lstat`, both ends of a rename go through this, and the deepest
   *  component that exists is resolved and re-tested against the resolved data dir. */
  private inside(path: string, verb: string): string {
    const root = resolve(this.cfg.dataDir)
    const target = resolve(path)
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`refusing to ${verb} ${target}: outside the data dir ${root}`)
    }
    if (target === root) throw new Error(`refusing to ${verb} the data dir itself (${root})`)
    this.assertNoSymlinkedComponent(root, target, verb)
    return target
  }

  /** Walk `root` down to `target`, rejecting a symlink at any step, then prove the real path of the
   *  deepest component that exists is still inside the real data dir. The walk stops at the first
   *  component that does not exist: a rename's destination normally does not, and nothing under a
   *  path that is not there can be a link. The data dir ITSELF may be a symlink (an operator's own
   *  choice, and both sides are resolved through it), which is why the comparison is between
   *  resolved paths and not a refusal to see one.
   *
   *  `lstat` needs only search permission on the PARENT, and every parent here is one the daemon
   *  created (the postgres image chowns the leaf PGDATA, not the directories above it), so this
   *  does not reach for the helper container. If it ever did fail on permissions the verb fails
   *  loudly, which is the safe direction for a delete and a promotion. */
  private assertNoSymlinkedComponent(root: string, target: string, verb: string): void {
    let deepest = root
    for (const part of target.slice(root.length + 1).split(sep)) {
      const step = join(deepest, part)
      let st
      try {
        st = lstatSync(step)
      } catch (e) {
        if (errnoOf(e) === 'ENOENT') return
        throw e
      }
      if (st.isSymbolicLink()) throw new Error(`refusing to ${verb} ${target}: ${step} is a symlink`)
      deepest = step
    }
    let real: string
    let realRoot: string
    try {
      real = realpathSync(deepest)
      realRoot = realpathSync(root)
    } catch (e) {
      if (errnoOf(e) === 'ENOENT') return
      throw e
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new Error(`refusing to ${verb} ${target}: it resolves to ${real}, outside the data dir ${realRoot}`)
    }
  }

  /** Legacy migration: copy a container's own volume (or a named volume) into the data dir without
   *  the daemon ever buffering a byte. The helper image is the only thing that can read both sides. */
  async copyFromContainerVolume(source: { container?: string; volume?: string }, containerPath: string, dst: string): Promise<void> {
    const dataDir = this.cfg.dataDir
    const src = source.container ? containerPath : '/src'
    const mount = source.container
      ? ['--volumes-from', source.container]
      : ['-v', `${source.volume}:/src:ro`]
    await docker([
      'run', '--rm', '-i', ...mount,
      '--mount', `type=bind,src=${dataDir},dst=${dataDir}`,
      this.cfg.data.helperImage, 'node', '-', 'clone', src, dst, '--reflink=auto',
    ], { input: readFileSync(scriptPath()) })
  }

  /** `PG_VERSION` exists: the second belt before any postgres start (decision 56). */
  async hasPgData(dir: string): Promise<boolean> {
    try {
      return readFileSync(join(dir, 'PG_VERSION'), 'utf8').trim().length > 0
    } catch (e) {
      if (errnoOf(e) === 'ENOENT') return false
      if (!HELPER_CODES.includes(errnoOf(e))) throw e
      const out = await this.runHelper(['stat', dir]) as { pgVersion?: string | null }
      return typeof out.pgVersion === 'string' && out.pgVersion.length > 0
    }
  }

  /** The provision guard: initdb runs only on an empty or missing directory. */
  async isEmptyOrMissing(dir: string): Promise<boolean> {
    try {
      return readdirSync(dir).length === 0
    } catch (e) {
      if (errnoOf(e) === 'ENOENT') return true
      if (!HELPER_CODES.includes(errnoOf(e))) throw e
      const out = await this.runHelper(['isempty', dir]) as { empty?: boolean }
      return out.empty === true
    }
  }

  // ---- runners ----

  /** One verb, in a short-lived child of the daemon, falling back to the helper container on the
   *  permission errors an unprivileged Linux daemon gets from a chowned PGDATA. The child reports
   *  those as exit 77, which `translateCloneError` turns back into an EACCES-coded error: a child's
   *  errno does not survive the process boundary on its own (see EXIT_DENIED). */
  private async runVerb(argv: string[], opts: { engine: CopyEngine; helperOnly?: boolean }): Promise<unknown> {
    if (opts.engine === 'helper' && opts.helperOnly) return this.runHelper(argv)
    try {
      return await this.runLocal(argv)
    } catch (e) {
      if (opts.engine !== 'helper' || !isHelperRetryable(e)) throw e
      return this.runHelper(argv)
    }
  }

  private async runLocal(argv: string[]): Promise<unknown> {
    try {
      const { stdout } = await execFileP(process.execPath, [scriptPath(), ...argv], { maxBuffer: 8 * 1024 * 1024 })
      return parseJson(stdout)
    } catch (e) {
      throw translateCloneError(e)
    }
  }

  private async runHelper(argv: string[]): Promise<unknown> {
    const dataDir = this.cfg.dataDir
    try {
      const out = await docker([
        'run', '--rm', '-i', '--mount', `type=bind,src=${dataDir},dst=${dataDir}`,
        this.cfg.data.helperImage, 'node', '-', ...argv,
      ], { input: readFileSync(scriptPath()) })
      return parseJson(out.toString())
    } catch (e) {
      throw translateCloneError(e)
    }
  }
}

/** What a failed `fsclone.cjs` run MEANS, from either runner.
 *
 *  exit 75 (or an errno that says the same thing) becomes NoReflinkError, which the postgres adapter
 *  turns into a `pg_basebackup` fork. exit 77 becomes an EACCES-CODED error, which is what `runVerb`
 *  recognises and retries in the helper container: the child's own errno never survives the process
 *  boundary, so the exit code is the only durable carrier (matching on stderr text would drift).
 *  Everything else passes through untouched. */
export function translateCloneError(e: unknown): unknown {
  const code = errnoOf(e)
  const status = e && typeof e === 'object' && 'code' in e ? (e as { code: unknown }).code : undefined
  const message = e instanceof Error ? e.message : String(e)
  if (status === EXIT_NO_REFLINK || /exit 75\b/.test(message) || /no reflink support/.test(message)) {
    return new NoReflinkError(message.trim() || 'no reflink support')
  }
  if (status === EXIT_DENIED || /exit 77\b/.test(message) || /permission denied: E/.test(message)) {
    const denied = new Error(message.trim() || 'permission denied')
    ;(denied as Error & { code: string }).code = 'EACCES'
    return denied
  }
  if (NO_REFLINK_CODES.includes(code)) return new NoReflinkError(code)
  return e
}

/** Whether `runVerb` would retry this error in the helper container. Exported for the tests that
 *  pin the pair: `translateCloneError` has to produce something this answers true for. */
export function isHelperRetryable(e: unknown): boolean { return HELPER_CODES.includes(errnoOf(e)) }

function parseJson(text: string): unknown {
  const t = text.trim()
  if (!t) return {}
  try { return JSON.parse(t) } catch { return {} }
}

/** One DataDir per process. `main.ts` builds it in its WP4 boot region and probes it; the postgres
 *  adapter and the engine's default read the SAME instance, so the probe result reaches them without
 *  main.ts threading a handle through every adapter constructor. Tests inject their own fake and
 *  never touch this. Construction does no I/O. */
let shared: DataDir | undefined
export function sharedDataDir(cfg?: Config): DataDir {
  if (!shared) shared = new DataDir(cfg ?? loadConfig())
  return shared
}

/** The boot probe's answer, or a conservative "no reflink" when nothing probed yet. */
export function probedCapabilities(): DataCapabilities { return sharedDataDir().capabilities() }

/** `DataDirOps` that resolves to the shared instance on first CALL, not at module load: the engine
 *  uses it as its default so `new Engine(...)` needs no boot wiring, and a test that never touches
 *  data never builds a config. */
export function lazyDataDirOps(): DataDirOps {
  return {
    probe: () => sharedDataDir().probe(),
    ensureDir: (p, mode) => sharedDataDir().ensureDir(p, mode),
    clonePostgres: (src, dst) => sharedDataDir().clonePostgres(src, dst),
    cloneTree: (src, dst) => sharedDataDir().cloneTree(src, dst),
    remove: (p) => sharedDataDir().remove(p),
    rename: (src, dst) => sharedDataDir().rename(src, dst),
    copyFromContainerVolume: (s, containerPath, dst) => sharedDataDir().copyFromContainerVolume(s, containerPath, dst),
    hasPgData: (dir) => sharedDataDir().hasPgData(dir),
    isEmptyOrMissing: (dir) => sharedDataDir().isEmptyOrMissing(dir),
  }
}

/** The one place that decides how a fork copies: an explicit `INSTA_OSS_FORK` wins, otherwise the
 *  boot probe does (04 section D.1). */
export function forkMethod(cfg: Config, caps: { reflink: boolean }): 'reflink' | 'basebackup' {
  if (cfg.data.fork === 'reflink') return 'reflink'
  if (cfg.data.fork === 'basebackup') return 'basebackup'
  return caps.reflink ? 'reflink' : 'basebackup'
}

/** Boot line for the log, plus the operator-facing hint in server mode (04 section A.2). */
export function capabilitiesLine(cfg: Config, caps: DataCapabilities): string {
  const base = `data dir ${caps.dataDir} reflink=${caps.reflink ? 'yes' : 'no'} engine=${caps.engine} mode=${cfg.mode}`
  return caps.reflink || cfg.mode !== 'server' ? base : `${base} (re-run the installer to get an XFS reflink volume)`
}

/** Directories under `pg/`, `vol/` and `md/` whose ref belongs to no branch: an interrupted
 *  provision or fork. Boot LOGS them and deletes only with INSTA_OSS_SWEEP_ORPHANS=1 (04 section G). */
export function orphanRoots(dataDir: string, liveRefs: readonly string[]): string[] {
  const live = new Set(liveRefs)
  const out: string[] = []
  for (const kind of ['pg', 'vol', 'md']) {
    const base = join(dataDir, kind)
    if (!existsSync(base)) continue
    for (const ref of readdirSync(base)) if (!live.has(ref)) out.push(join(base, ref))
  }
  return out
}
