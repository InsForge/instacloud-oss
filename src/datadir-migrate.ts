// One-time boot migration of installs that predate the data directory (decision 24). Before it,
// every byte lived inside a container layer or a docker NAMED volume, which cannot be reflinked and
// disappears with a `docker rm -v`; after it, each branch's bytes sit under `cfg.dataDir` on bind
// mounts and `Branch.dataVersion` is 1.
//
// Three properties matter more than speed here:
//   - RESUMABLE: a daemon killed at ANY point redoes only what it did not finish, and never
//     mistakes an unfinished step for a finished one. That is what `copyIntoPlace` buys: every copy
//     lands in a sibling `.incoming-<name>` staging directory and is promoted with ONE atomic
//     rename, so a destination that EXISTS is a destination that is whole. Asking the destination
//     itself ("is `PG_VERSION` there?", "is this directory non-empty?") answers YES halfway through
//     a copy -- `PG_VERSION` is a handful of bytes the walk writes early -- and the step that
//     follows a copy is the one that DELETES the source, so the wrong answer costs the only
//     complete copy of a user's data. The same rule orders the rest of each step: a source
//     container or volume is removed only once its destination is known good, and the state row is
//     the LAST thing written, so a crash before it is a crash the next boot still sees as unfinished
//     (a container that exists but that no row names is not a migration that happened);
//   - NON-BLOCKING: a branch that cannot be migrated is logged and skipped, the daemon still boots,
//     and only `createBranch` from that branch refuses (a fork would clone an empty directory);
//   - NO BUFFERING: the bytes move container-to-bind-mount inside the helper image
//     (`data.copyFromContainerVolume`), never through the daemon.
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { docker, inspectField, UNREADABLE, UnreadableProbeError } from './docker'
import { pgAppendHba, pgRun, pgWaitReady } from './adapters/postgres'
import { appContainerName, dataPaths, managedContainerName, pgContainerName } from './manageddb'
import { loadState, mutate } from './state'
import type { Config } from './config'
import type { Branch, DataDirOps, ManagedDbTarget, ManagedDbType, Project, ServiceLimits } from './types'

const LEGACY_PGDATA = '/var/lib/postgresql/data'

export interface MigrateDeps {
  cfg: Config
  data: DataDirOps
  layout(): { pg(ref: string, dataId: string): string; vol(ref: string, volId: string): string; md(ref: string, type: ManagedDbType, dataId: string): string; branchRoots(ref: string): string[] }
  ref(branch: Branch): string
  /** `db.query`, for the `pg_reload_conf()` after the hba line. */
  query(container: string, sql: string): Promise<string>
  /** `managedDb.provision`, to re-create a managed container on its new bind mounts. */
  provisionManaged(t: ManagedDbTarget, opts?: { publishLoopback?: boolean; limits?: ServiceLimits }): Promise<void>
  /** `engine.deploy`, to re-create one compute container on its new bind mount while preserving the
   *  recorded lifecycle intent. */
  redeploy(projectId: string, branchName: string, group: string, opts: { image: string; port: number; hostPort?: number }): Promise<void>
}

export interface MigrateResult { migrated: string[]; skipped: string[]; failed: Array<{ ref: string; error: string }> }

export async function migrateLegacyData(deps: MigrateDeps): Promise<MigrateResult> {
  const out: MigrateResult = { migrated: [], skipped: [], failed: [] }
  if (!deps.cfg.data.migrate) return out
  // BEFORE the snapshot, and before any branch: a managed service's `dataId` is PROJECT-level
  // (every branch's directory is `md/<ref>/<prefix>-<dataId>`), and a pre-scaffold registration
  // has none. Minting it inside the per-branch loop minted a DIFFERENT id per branch, wrote each
  // one to persisted state and left the in-memory registration this loop iterates untouched, so
  // the next branch saw no id and minted again. Every branch copied its files under its own id
  // while the registration kept only the last, and every later engine operation derives every
  // branch's path from that one id: the earlier branches' directories were unreferenced, and
  // gone as soon as a container was recreated. One id, minted once, persisted before the
  // snapshot below is taken, so the object this loop reads and the row on disk are the same.
  backfillManagedDataIds()
  const s = loadState()
  for (const branch of Object.values(s.branches)) {
    const project = s.projects[branch.projectId]
    if (!project) continue
    const ref = deps.ref(branch)
    if (branch.dataVersion === 1) { out.skipped.push(ref); continue }
    try {
      // `dataVersion: 1` is the one irreversible write in this file: `assertMigrated` is
      // fail-closed against it, nothing ever re-runs a stamped branch, and a branch stamped
      // without having been migrated is a branch whose bytes are still in a docker volume that
      // `docker rm -v` can take. So it is written only on a POSITIVE answer -- every probe below
      // either answers or raises `UnreadableProbeError`, and a raise lands in `failed` with the
      // row untouched, so the next boot sees the branch exactly as this one found it.
      const touched = await migrateBranch(deps, project, branch)
      mutate((st) => { const b = st.branches[branch.id]; if (b) b.dataVersion = 1 })
      if (touched) out.migrated.push(ref)
      else out.skipped.push(ref)
    } catch (e) {
      out.failed.push({ ref, error: e instanceof Error ? e.message : String(e) })
    }
  }
  if (out.migrated.length || out.failed.length) {
    console.log(`data migration: ${out.migrated.length} migrated, ${out.skipped.length} skipped, ${out.failed.length} failed`)
    for (const f of out.failed) console.warn(`data migration failed for ${f.ref}: ${f.error}`)
  }
  return out
}

/** Give every managed registration that predates `dataId` a stable one, in ONE mutate over the
 *  whole state. Idempotent: a row that already has an id keeps it, so a boot after a partial
 *  migration reuses the id its directories were copied under. */
function backfillManagedDataIds(): void {
  mutate((st) => {
    for (const p of Object.values(st.projects)) {
      for (const m of p.managedServices ?? []) if (!m.dataId) m.dataId = randomUUID().slice(0, 8)
    }
  })
}

/** True when this branch actually had something to move. */
async function migrateBranch(deps: MigrateDeps, project: Project, branch: Branch): Promise<boolean> {
  const pg = await migratePostgres(deps, project, branch)
  const vols = await migrateVolumes(deps, project, branch)
  const managed = await migrateManaged(deps, project, branch)
  return pg || vols || managed
}

// ---- postgres ----

async function migratePostgres(deps: MigrateDeps, project: Project, branch: Branch): Promise<boolean> {
  const ref = deps.ref(branch)
  const entry = (project.dbServices ?? []).find((d) => d.id === 'pg-db')
  const name = entry?.name ?? 'db'
  const dataId = entry?.dataId ?? branch.databases?.['pg-db']?.dataId ?? 'db'
  const target = deps.layout().pg(ref, dataId)
  const legacy = legacyPgContainer(branch, ref)
  const fresh = pgContainerName(ref, name)
  const legacyExists = legacy !== fresh && (await exists(legacy))
  const freshExists = await exists(fresh)

  // Fully migrated already -- and the STATE ROW is what says so, not the container. The row is the
  // last write of this function, so a daemon killed between `docker run` and that write leaves a
  // `fresh` container nothing names while `branch.databases['pg-db'].container` still names a
  // legacy container this pass then deletes. Trusting the container alone made that boot report
  // "nothing to do", stamp `dataVersion: 1`, and leave the branch pointing at a container that no
  // longer exists.
  if (!legacyExists && freshExists && pgRowSettled(branch.id, fresh, dataId)) return false

  // The safe default, and only an EXPLICIT `false` may overturn it: this decides whether the
  // re-created database is left running, and stopping one that was up is a silent outage on the
  // boot path. A container that vanished between the two reads answers null, which is not an
  // answer about intent, so the default stands. (An unreadable probe no longer reaches here at
  // all: `inspect` raises and the branch is retried next boot.)
  let wasRunning = true
  if (legacyExists) {
    wasRunning = (await inspect(legacy, '{{.State.Running}}')) !== 'false'
    await stopForCopy(legacy)
    if (!(await pgDataComplete(deps, target))) {
      // Staged, verified, promoted -- and only THEN is the legacy container (and with it the
      // anonymous volume holding the only complete copy of these bytes) removed.
      await copyIntoPlace(deps, { container: legacy }, LEGACY_PGDATA, target, 0o700, async (staged) => {
        if (!(await pgDataComplete(deps, staged))) throw new Error(`copy of ${legacy} left an incomplete PGDATA in ${staged}`)
      })
    }
    // The removal stays HERE, after a verified copy and before the replacement runs, and that is
    // a deliberate limit rather than an oversight. Holding it until `pgRun` has started the new
    // container would be safer still on this arm, but the managed arm structurally cannot do it
    // (its replacement REUSES the legacy container's name, so the removal has to come first), and
    // a rule that holds on one arm and not the other is how this file gets a fourth defect. What
    // makes the removal safe is what is now above it: the source is proven at rest, and the copy
    // is staged, verified and promoted before anything is deleted.
    await docker(['rm', '-f', '-v', legacy]).catch(() => { /* raced away */ })
  } else if (!(await pgDataComplete(deps, target))) {
    // nothing to migrate and nothing migrated: a branch whose database was never provisioned
    return false
  } else if (freshExists) {
    // Resuming after a crash between `docker run` and the state write: the container is there but
    // no row names it. Take its lifecycle intent back off it before it is replaced below, or a
    // database the developer had stopped comes back running.
    wasRunning = (await inspect(fresh, '{{.State.Running}}')) !== 'false'
  }

  // re-create under the new name on the bind mount. The directory is non-empty, so the image skips
  // initdb and the existing password, hba and conf travel with the files: only the DSN's HOST moves.
  // An unnamed leftover from an interrupted run is replaced rather than raced: its bytes are on the
  // bind mount, so the container itself carries nothing worth keeping.
  if (freshExists) await docker(['rm', '-f', fresh]).catch(() => { /* raced away */ })
  await pgRun({ container: fresh, network: branch.network, dataDir: target }, { publishLoopback: deps.cfg.mode === 'local' })
  await pgWaitReady(fresh)
  await pgAppendHba(fresh)
  await deps.query(fresh, 'select pg_reload_conf()').catch(() => { /* reload is best effort */ })
  if (!wasRunning) await docker(['stop', fresh]).catch(() => {})
  mutate((st) => {
    const b = st.branches[branch.id]
    if (!b) return
    const url = b.databases?.['pg-db']?.url ?? b.dbUrl
    const moved = url ? swapUrlHost(url, fresh) : url
    if (b.databases?.['pg-db']) {
      b.databases['pg-db'].container = fresh
      if (moved) b.databases['pg-db'].url = moved
      b.databases['pg-db'].dataId = dataId
    }
    if (moved) b.dbUrl = moved
  })
  return true
}

/** Stop a container and PROVE it stopped, before a single byte is read out of it.
 *
 *  `docker stop` was `.catch(() => {})` here, on both arms, commented "already down" -- which is
 *  ONE of the things a failed stop means and not the one that matters. The others are "still
 *  running": a stop that timed out, a daemon that did not answer, a container that refused the
 *  signal. The copy that follows then reads a LIVE Postgres or Redis, which is not
 *  crash-consistent, and the `docker rm -f -v` after it deletes the anonymous volume holding the
 *  only authoritative copy. Third instance of one rule in this file: the probes were fixed and
 *  the stop was never looked at.
 *
 *  The classification is the one `inspect` already uses, not a fourth: an explicit `false` is
 *  permission to copy; `true` is a live writer; `null` is a container that went away while we
 *  were stopping it, so there is nothing to copy from; and a probe that cannot answer raises out
 *  of `inspect` itself. Every path but the first leaves the branch unmigrated, which is the
 *  outcome this whole file is built around: the source is untouched and the next boot retries. */
async function stopForCopy(container: string): Promise<void> {
  // The error is deliberately not read: whatever it says, the state below is the evidence.
  await docker(['stop', container]).catch(() => { /* classified by the probe, not by the error */ })
  const running = await inspect(container, '{{.State.Running}}')
  if (running === null) {
    throw new Error(`${container} disappeared while it was being stopped, so its data cannot be copied; this branch is left unmigrated and the next boot retries it`)
  }
  if (running !== 'false') {
    throw new Error(`could not stop ${container} (docker still reports it running), so its data directory has a live writer and copying it would not be crash-consistent; nothing was copied or removed, and the next boot retries this branch`)
  }
}

/** The handle a legacy row carries (`io-<ref>-pg`), read from state when present (decision 17). */
function legacyPgContainer(branch: Branch, ref: string): string {
  return branch.databases?.['pg-db']?.container ?? `io-${ref}-pg`
}

/** Whether the state row has already been moved onto the new container, read FRESH: the branch
 *  snapshot this pass started from predates any write this pass made. */
function pgRowSettled(branchId: string, fresh: string, dataId: string): boolean {
  const row = loadState().branches[branchId]?.databases?.['pg-db']
  return row?.container === fresh && row?.dataId === dataId
}

/** Whether `dir` holds a WHOLE PGDATA, not the first few files of one.
 *
 *  What this proves and what it does not, stated plainly, because its presence is part of why
 *  the arm above looked safe: it proves the copy did not STOP EARLY. It says nothing at all
 *  about whether the bytes are crash-consistent -- a file-level copy of a running Postgres
 *  passes this check and may still be unrecoverable. Only a source with no writer gives
 *  consistency, which is what `stopForCopy` is for; this is the other half, and neither
 *  substitutes for the other.
 *
 *  `PG_VERSION` is four bytes the copy walk writes as soon as it reaches that name, so it is there
 *  long before the tree is: the old check treated an interrupted copy as a finished one and the
 *  caller then deleted the source. A postmaster refuses to start without `global/` (pg_control) and
 *  `base/` (every database's files), and neither is ever legitimately empty, so requiring all three
 *  is both cheap and unambiguous. Both predicates carry the helper-container fallback, so this
 *  reads a PGDATA the postgres image chowned 0700 to its own uid. */
async function pgDataComplete(deps: MigrateDeps, dir: string): Promise<boolean> {
  if (!(await deps.data.hasPgData(dir))) return false
  for (const sub of ['global', 'base']) {
    if (await deps.data.isEmptyOrMissing(join(dir, sub))) return false
  }
  return true
}

/** Where a copy is built before it is promoted: a sibling of the destination, so the promotion is a
 *  same-filesystem rename and a leftover is obvious (and swept) on the next boot. */
function stagingFor(target: string): string {
  return join(dirname(target), `.incoming-${basename(target)}`)
}

/** Copy container bytes so that `target` exists ONLY when the copy that filled it finished.
 *
 *  Any leftover staging directory is discarded first and the copy restarts from the source, which
 *  is still there because every caller removes its source only after this resolves. `verify` runs
 *  on the staged copy, before anything is promoted or deleted, so a copy that ended early fails the
 *  step instead of passing for a finished one. */
async function copyIntoPlace(
  deps: MigrateDeps,
  source: { container?: string; volume?: string },
  containerPath: string,
  target: string,
  mode: number,
  verify?: (staged: string) => Promise<void>,
): Promise<void> {
  const staging = stagingFor(target)
  await deps.data.remove(staging)
  await deps.data.ensureDir(staging, mode)
  await deps.data.copyFromContainerVolume(source, containerPath, staging)
  if (verify) await verify(staging)
  // A partial destination from a run that predates this one, or from an interrupted promotion.
  await deps.data.remove(target)
  await deps.data.rename(staging, target)
}

// ---- compute /data volumes ----

async function migrateVolumes(deps: MigrateDeps, project: Project, branch: Branch): Promise<boolean> {
  const ref = deps.ref(branch)
  let touched = false
  for (const [group, app] of Object.entries(branch.apps ?? {})) {
    const vol = project.computeVolumes?.[group]
    if (!vol) continue
    const legacy = `io-${ref}-data-${vol.id}`
    if (!(await volumeExists(legacy))) continue
    const target = deps.layout().vol(ref, vol.id)
    // The app already reading the bind mount is what says this service is done, not the directory
    // being non-empty: a `/data` that was legitimately EMPTY copies to an empty destination, and a
    // `volume rm` that failed once ("still referenced") would then bring this pass back every boot
    // to copy the empty source over whatever the live app had written since.
    const mounts = await mountsOf(appContainerName(ref, group))
    if (mounts === null || !mountsInclude(mounts, target)) {
      // The app is NOT on the bind mount, so it is still reading the legacy volume and the volume
      // is the only complete copy. Anything already at the target is therefore at best an
      // interrupted copy from a build that predates the staging discipline, and skipping the copy
      // because it is "not empty" is what loses the files it never got to: the `volume rm` below
      // then takes the source away. Recopy. `copyIntoPlace` stages the whole thing beside the
      // target and promotes with one rename, so the partial destination is replaced only once the
      // new copy is complete.
      //
      // The one case that is NOT recopied is a target with something in it and no app container at
      // all. Then neither side can be shown to be the newer one: it may be a partial copy, or it
      // may be what a finished migration left and a since-removed app wrote to. Copying would
      // destroy live data and skipping the removal below cannot, so nothing is copied and the
      // legacy volume is KEPT for the operator rather than deleted on a guess.
      const ambiguous = mounts === null && !(await deps.data.isEmptyOrMissing(target))
      if (!ambiguous) await copyIntoPlace(deps, { volume: legacy }, '/src', target, 0o777)
      else console.warn(`keeping docker volume ${legacy}: ${target} already has data and no container names either, so neither can be shown to be the newer copy`)
      // Recreate the container on the bind mount. `deploy` re-asserts the recorded lifecycle intent,
      // so a service the developer had stopped stays stopped.
      await deps.redeploy(branch.projectId, branch.name, group, { image: app.image, port: app.port, hostPort: app.hostPort })
      if (ambiguous) { touched = true; continue }
    }
    // The bytes are already promoted and the app is on the bind mount, so a removal that fails
    // costs disk and not data. It is NOT retried, whatever the old comment here said: this
    // branch is about to be stamped `dataVersion: 1` and no later boot looks at it again, so say
    // so and leave the operator something to act on rather than a silent leftover.
    await docker(['volume', 'rm', legacy]).catch((e: unknown) => {
      console.warn(`could not remove legacy docker volume ${legacy} (${e instanceof Error ? e.message : String(e)}); the data is migrated and this volume is now unused, remove it with \`docker volume rm ${legacy}\``)
    })
    touched = true
  }
  return touched
}

// ---- managed databases ----

async function migrateManaged(deps: MigrateDeps, project: Project, branch: Branch): Promise<boolean> {
  const ref = deps.ref(branch)
  let touched = false
  for (const m of project.managedServices ?? []) {
    // Never minted here: `backfillManagedDataIds` ran before the state this iterates was read,
    // so an id is missing only if a registration appeared between the two, and inventing one for
    // it per branch is the defect this line used to be. Nothing to migrate for such a row.
    const dataId = m.dataId
    if (!dataId) {
      console.warn(`skipping managed service ${m.id} on ${ref}: it has no dataId (registered while the boot migration was running)`)
      continue
    }
    const container = managedContainerName(ref, m.type, m.name)
    const dir = deps.layout().md(ref, m.type, dataId)
    const containerExists = await exists(container)
    if (containerExists && (await hasMount(container, dir))) continue
    // The re-create below has to reuse the legacy container's NAME, so the removal cannot wait for
    // it. A daemon killed in that gap leaves the bytes under `md/` with no container at all, and
    // asking `exists(container)` alone answered "nothing here to migrate" -- the service then
    // stayed missing for good. A data directory with something in it is the record that this
    // migration started, so finish it.
    if (!containerExists) {
      if (await deps.data.isEmptyOrMissing(dir)) continue
    }
    // Same rule as the postgres arm: the safe default is running, and only an explicit `false`
    // overturns it.
    let wasRunning = true
    if (containerExists) {
      wasRunning = (await inspect(container, '{{.State.Running}}')) !== 'false'
      await stopForCopy(container)
      for (const p of dataPaths(m.type)) {
        // Unconditionally: this block runs only when the container EXISTS and is not on the bind
        // mount, so the container is still the authority on these bytes and anything already at
        // the target is at best an interrupted copy from a build that predates staging. Skipping
        // it because the directory was "not empty" left those missing files behind and the
        // `docker rm -f -v` below then took the source away. (The reverse reading is not available
        // either: `/data/configdb` and a redis `/data` with no dump.rdb are legitimately empty, so
        // non-empty never meant copied. `copyIntoPlace` stages and promotes with one rename, so
        // the target is replaced only once the new copy is whole.)
        await copyIntoPlace(deps, { container }, p.containerPath, join(dir, p.sub), 0o700)
      }
      await docker(['rm', '-f', '-v', container]).catch(() => {})
    }
    const password = branch.managed?.[m.id]?.password
    if (password === undefined) throw new Error(`no stored password for ${m.id} on ${ref}`)
    await deps.provisionManaged(
      { container, network: branch.network, type: m.type, name: m.name, password, dataDir: dir },
      { publishLoopback: deps.cfg.mode === 'local' },
    )
    if (!wasRunning) await docker(['stop', container]).catch(() => {})
    touched = true
  }
  return touched
}

/** The container's bind sources, or null when dockerd says the container is not there at all.
 *  The difference matters: "not mounted here" and "no container to ask" are different pieces of
 *  evidence about which copy of a directory is the live one -- and "could not ask" is a third
 *  thing, which `inspect` raises rather than folding into the null. */
async function mountsOf(container: string): Promise<string[] | null> {
  const out = await inspect(container, '{{range .Mounts}}{{.Source}} {{end}}')
  return out === null ? null : out.split(' ').filter(Boolean)
}

const mountsInclude = (mounts: readonly string[], dir: string): boolean =>
  mounts.some((s) => s === dir || s.startsWith(`${dir}/`))

/** Whether the container already binds this data directory: the case where an earlier run finished
 *  the copy and the re-create, so there is nothing left to do. A container dockerd says is not
 *  there answers false; a probe that could not answer raises, because "there is nothing left to
 *  do" is the one conclusion an unanswered probe must not produce here. */
async function hasMount(container: string, dir: string): Promise<boolean> {
  const mounts = await mountsOf(container)
  return mounts !== null && mountsInclude(mounts, dir)
}

/** One `docker inspect -f`, three ways, with the third one RAISED rather than returned.
 *
 *  This whole file used to collapse "dockerd says there is no such container" and "the probe
 *  could not answer" into one `null`, and every predicate below inherited it: `exists` read an
 *  unreadable daemon as "not there", `hasMount` as "not on the bind mount", `wasRunning` as "it
 *  was stopped". Each of those routes an unknown into the ACCEPTING branch, and the accepting
 *  branch here means "nothing to migrate" -- after which `migrateLegacyData` stamps
 *  `dataVersion: 1` and the branch is never looked at again, while `assertMigrated`, which is
 *  fail-closed against exactly that flag, is satisfied by a flag set on no evidence.
 *
 *  Raising is the right shape for this file specifically: `migrateLegacyData` already catches
 *  per branch, records the failure and DOES NOT stamp the row, so an unreadable docker at boot
 *  now leaves the branch unmigrated and retried on the next boot, which is what it always
 *  claimed to do. */
async function inspect(nameOrId: string, format: string): Promise<string | null> {
  // The seam is passed EXPLICITLY: `inspectField`'s own default binds the real CLI, and this
  // file's docker is the one its callers inject.
  const out = await inspectField(nameOrId, format, docker)
  if (out === UNREADABLE) {
    throw new UnreadableProbeError(`docker could not report ${format} for ${nameOrId}: this branch is left unmigrated and the next boot retries it`)
  }
  return out
}

/** Docker says the container is there. An unreadable probe raises rather than answering `false`. */
async function exists(container: string): Promise<boolean> {
  return (await inspect(container, '{{.Id}}')) !== null
}

/** Docker's own "there is no such volume", in both spellings (`docker volume inspect` answers the
 *  client-side `No such object` on some versions and dockerd's `No such volume` on others). */
const NO_SUCH_VOLUME = /no such (?:object|volume)/i

/** The same three ways for a named volume. `false` used to swallow an unreadable daemon, and the
 *  caller reads `false` as "no legacy volume, nothing to copy" and then stamps the branch. */
async function volumeExists(volume: string): Promise<boolean> {
  try {
    await docker(['volume', 'inspect', volume])
    return true
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    if (NO_SUCH_VOLUME.test(m)) return false
    throw new UnreadableProbeError(`docker could not report whether volume ${volume} exists (${m}): this branch is left unmigrated and the next boot retries it`)
  }
}

/** Only the DSN's host changes: a re-created container keeps the same files, roles and password. */
export function swapUrlHost(url: string, container: string): string {
  const at = url.lastIndexOf('@')
  if (at === -1) return url
  const rest = url.slice(at + 1)
  const slash = rest.indexOf('/')
  return `${url.slice(0, at + 1)}${container}:5432${slash === -1 ? '' : rest.slice(slash)}`
}
