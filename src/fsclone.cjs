#!/usr/bin/env node
'use strict'
// Dependency-free CommonJS copy program for the InstaCloud OSS data directory (contract 00 section 12,
// 04 section H). It runs two ways, with the SAME argv:
//   - as a short-lived child of the daemon (`node src/fsclone.cjs <argv>`): the `ficlone` engine on
//     Linux (fs.copyFile + COPYFILE_FICLONE_FORCE) and the `cp-c` engine on macOS (/bin/cp -c -a,
//     clonefile, one spawn per top-level entry);
//   - piped to `node -` inside the node:22-alpine helper container, for an unprivileged Linux daemon
//     that cannot read a PGDATA chowned to the image's postgres uid.
// It never requires anything outside node core, because the helper container has no node_modules.
//
// Verbs (JSON on stdout):
//   probe <dir>            -> {"reflink":bool,"code":string?}
//   clone <src> <dst> [--pg] [--reflink=always|auto] [--engine=ficlone|cp-c]
//                          -> {"files":n,"bytes":n,"ms":n,"method":"reflink"|"copy"}
//   rm <path>              -> {"removed":true}
//   mv <src> <dst>         -> {"moved":true}
//   stat <dir>             -> {"exists":bool,"pgVersion":string|null}
//   isempty <dir>          -> {"empty":bool}
// Exit 75 means: the target filesystem cannot reflink and --reflink=always was asked for
// (the caller then streams pg_basebackup, or plain-copies a volume).
// Exit 77 means: this process cannot read (or write) those bytes, EACCES or EPERM. It has a code of
// its own because a CHILD PROCESS cannot hand an errno back: a promisified `execFile` rejection
// carries the child's exit STATUS in `e.code`, so a plain exit 1 reached `src/datadir.ts` as the
// string "1" and its helper-container fallback -- the whole answer to an unprivileged Linux daemon
// meeting a PGDATA the postgres image chowned 0700 to its own uid -- could never fire.
//
// Test hooks, never set in production: INSTA_OSS_FSCLONE_FSTYPE forces the filesystem answer,
// INSTA_OSS_FSCLONE_CP overrides the cp binary, INSTA_OSS_FSCLONE_TRACE appends one JSON line per cp
// spawn to that file, INSTA_OSS_FSCLONE_HOOK runs a shell command right after the first pg_control
// snapshot (the mid-walk mutation case).

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const FICLONE = fs.constants.COPYFILE_FICLONE_FORCE
// ENOSYS joins the list on every platform: darwin's libuv answers it for COPYFILE_FICLONE_FORCE and
// Linux filesystems without reflinks answer ENOTSUP or EOPNOTSUPP (decision 23).
const NO_REFLINK = new Set(['ENOSYS', 'ENOTSUP', 'EXDEV', 'EINVAL', 'EOPNOTSUPP'])
const EXIT_NO_REFLINK = 75
const EXIT_DENIED = 77
const DENIED = new Set(['EACCES', 'EPERM'])

// PGDATA scrub, applied to the COPY (never the source): runtime scratch a recovering postmaster must
// not inherit. The directories stay, their contents go.
const SCRUB_EMPTY = ['pg_dynshmem', 'pg_notify', 'pg_replslot', 'pg_serial', 'pg_snapshots', 'pg_stat_tmp', 'pg_subtrans']
const SCRUB_FILES = ['postmaster.pid', 'postmaster.opts', 'backup_label.old', 'tablespace_map.old']

class NoReflink extends Error {}

function isNoReflink(e) { return !!e && NO_REFLINK.has(e.code) }

/** Filesystem type of the longest mount-point prefix of `dir`, or null when unknown.
 *  `/sbin/mount` prints `<dev> on <mountpoint> (<fstype>, <opts>...)` on macOS and Linux alike. */
function fsTypeOf(dir) {
  if (process.env.INSTA_OSS_FSCLONE_FSTYPE) return process.env.INSTA_OSS_FSCLONE_FSTYPE
  let out
  try { out = execFileSync('/sbin/mount', [], { encoding: 'utf8' }) }
  catch { return null }
  let best = null
  let bestLen = -1
  const target = path.resolve(dir)
  for (const line of out.split('\n')) {
    const m = /^\S+ on (.+?) \(([^,)]+)/.exec(line.trim())
    if (!m) continue
    const mp = m[1]
    if ((target === mp || target.startsWith(mp === '/' ? '/' : mp + '/')) && mp.length > bestLen) {
      bestLen = mp.length
      best = m[2]
    }
  }
  return best
}

function cpBin() { return process.env.INSTA_OSS_FSCLONE_CP || '/bin/cp' }

function trace(argv) {
  const f = process.env.INSTA_OSS_FSCLONE_TRACE
  if (f) fs.appendFileSync(f, JSON.stringify(argv) + '\n')
}

// ---- engines ----

const stats = { files: 0, bytes: 0, fellBack: false }

/** One file, cloned when the filesystem allows it. `always` turns a fallback into exit 75. */
function copyFile(src, dst, reflink) {
  try {
    fs.copyFileSync(src, dst, FICLONE)
  } catch (e) {
    if (!isNoReflink(e)) throw e
    if (reflink === 'always') throw new NoReflink(e.code)
    fs.copyFileSync(src, dst)
    stats.fellBack = true
  }
  stats.files++
  try { stats.bytes += fs.lstatSync(dst).size } catch { /* raced away; the count is informational */ }
}

/** Recursive walk for the `ficlone` engine: directories keep mode, owner (only a root daemon can
 *  chown) and mtime; symlinks are recreated as symlinks; files are cloned. */
function cloneEntry(src, dst, reflink) {
  const st = fs.lstatSync(src)
  if (st.isSymbolicLink()) {
    const target = fs.readlinkSync(src)
    try { fs.unlinkSync(dst) } catch { /* not there */ }
    fs.symlinkSync(target, dst)
    if (process.getuid && process.getuid() === 0) fs.lchownSync(dst, st.uid, st.gid)
    return
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true })
    for (const name of fs.readdirSync(src)) cloneEntry(path.join(src, name), path.join(dst, name), reflink)
    if (process.getuid && process.getuid() === 0) fs.lchownSync(dst, st.uid, st.gid)
    fs.chmodSync(dst, st.mode & 0o7777)
    try { fs.utimesSync(dst, st.atime, st.mtime) } catch { /* best effort */ }
    return
  }
  if (!st.isFile()) return // sockets and fifos never belong to a copy
  copyFile(src, dst, reflink)
  if (process.getuid && process.getuid() === 0) fs.lchownSync(dst, st.uid, st.gid)
  fs.chmodSync(dst, st.mode & 0o7777)
}

/** macOS: ONE `/bin/cp -c -a` per top-level entry (or per tree), never per file. `-a` is `-pPR`
 *  (modes, times, symlinks kept as links, recursive). `cp -c` falls back to copyfile(2) SILENTLY
 *  when the target has no clonefile, so `always` pre-checks the filesystem instead of trusting cp. */
function cpClone(src, dst, reflink) {
  const apfs = fsTypeOf(path.dirname(path.resolve(dst))) === 'apfs'
  if (reflink === 'always' && !apfs) throw new NoReflink('ENOTSUP')
  const args = apfs ? ['-c', '-a', src, dst] : ['-a', src, dst]
  if (!apfs) stats.fellBack = true
  trace([cpBin()].concat(args))
  try {
    execFileSync(cpBin(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (e) {
    if (reflink === 'always') throw new NoReflink('cp exit ' + (e.status === undefined ? 'error' : e.status))
    if (!apfs) throw e
    // clonefile refused mid-copy: retry the same entry as a plain copy
    stats.fellBack = true
    const plain = ['-a', src, dst]
    trace([cpBin()].concat(plain))
    execFileSync(cpBin(), plain, { stdio: ['ignore', 'ignore', 'pipe'] })
  }
  stats.files++
}

function cloneOne(src, dst, reflink, engine) {
  if (engine === 'cp-c') cpClone(src, dst, reflink)
  else cloneEntry(src, dst, reflink)
}

// ---- PGDATA order ----

function emptyDir(dir) {
  let names
  try { names = fs.readdirSync(dir) } catch { return }
  for (const n of names) fs.rmSync(path.join(dir, n), { recursive: true, force: true })
}

function dropInternalInit(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) dropInternalInit(p)
    else if (e.name === 'pg_internal.init') fs.rmSync(p, { force: true })
  }
}

/** A running postmaster rewrites `global/pg_control` while we walk. Copy it FIRST, plainly, keep the
 *  snapshot beside the copy, and move it into place LAST: the clone then recovers from a checkpoint
 *  record no younger than the oldest file it holds. `pg_wal` is copied last for the same reason. */
function clonePg(src, dst, reflink, engine) {
  fs.mkdirSync(dst, { recursive: true })
  const control = path.join(src, 'global', 'pg_control')
  const snapshot = path.join(dst, '.pg_control.fork')
  let haveControl = false
  try {
    fs.writeFileSync(snapshot, fs.readFileSync(control))
    haveControl = true
  } catch (e) {
    if (e.code !== 'ENOENT') throw e // a source without pg_control is not a PGDATA
  }
  if (process.env.INSTA_OSS_FSCLONE_HOOK) {
    execFileSync('/bin/sh', ['-c', process.env.INSTA_OSS_FSCLONE_HOOK], { stdio: ['ignore', 'ignore', 'ignore'] })
  }
  const entries = fs.readdirSync(src).sort()
  for (const name of entries) {
    if (name === 'pg_wal') continue
    cloneOne(path.join(src, name), path.join(dst, name), reflink, engine)
  }
  if (entries.indexOf('pg_wal') !== -1) cloneOne(path.join(src, 'pg_wal'), path.join(dst, 'pg_wal'), reflink, engine)
  if (haveControl) {
    fs.mkdirSync(path.join(dst, 'global'), { recursive: true })
    fs.renameSync(snapshot, path.join(dst, 'global', 'pg_control'))
  }
  for (const d of SCRUB_EMPTY) emptyDir(path.join(dst, d))
  for (const f of SCRUB_FILES) fs.rmSync(path.join(dst, f), { force: true })
  dropInternalInit(dst)
  fs.chmodSync(dst, fs.statSync(src).mode & 0o7777)
}

/** A whole tree (a compute /data volume): the CONTENTS of src land directly under dst.
 *
 *  One spawn per top-level entry on the cp-c engine, not one for the lot: BSD cp has no
 *  "copy the contents" form, and `cp -a src/. dst/` copied the source DIRECTORY into dst, so a
 *  forked branch got `vol/<ref>/<id>/<id>/...` and its container mounted an empty /data. */
function cloneWholeTree(src, dst, reflink, engine) {
  fs.mkdirSync(dst, { recursive: true })
  for (const name of fs.readdirSync(src)) cloneOne(path.join(src, name), path.join(dst, name), reflink, engine)
}

// ---- verbs ----

function probe(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const src = path.join(dir, 'probe.src')
  const dst = path.join(dir, 'probe.dst')
  fs.writeFileSync(src, Buffer.alloc(1024, 7))
  fs.rmSync(dst, { force: true })
  try {
    if (process.platform === 'darwin') {
      if (fsTypeOf(dir) !== 'apfs') return { reflink: false, code: 'ENOTSUP' }
      execFileSync(cpBin(), ['-c', src, dst], { stdio: ['ignore', 'ignore', 'pipe'] })
    } else {
      fs.copyFileSync(src, dst, FICLONE)
    }
    return { reflink: true }
  } catch (e) {
    return { reflink: false, code: e && e.code ? String(e.code) : 'exit ' + (e && e.status) }
  } finally {
    fs.rmSync(src, { force: true })
    fs.rmSync(dst, { force: true })
  }
}

function main(argv) {
  const flags = {}
  const pos = []
  for (const a of argv) {
    if (a.slice(0, 2) === '--') {
      const kv = a.slice(2).split('=')
      flags[kv[0]] = kv[1] === undefined ? 'true' : kv[1]
    } else pos.push(a)
  }
  const verb = pos[0]
  if (verb === 'probe') return probe(pos[1] || path.join(process.cwd(), '.probe'))
  if (verb === 'clone') {
    const src = pos[1]
    const dst = pos[2]
    if (!src || !dst) throw new Error('clone needs <src> <dst>')
    const reflink = flags.reflink === 'always' ? 'always' : 'auto'
    const engine = flags.engine === 'cp-c' ? 'cp-c' : 'ficlone'
    const t0 = Date.now()
    if (flags.pg) clonePg(src, dst, reflink, engine)
    else cloneWholeTree(src, dst, reflink, engine)
    return { files: stats.files, bytes: stats.bytes, ms: Date.now() - t0, method: stats.fellBack ? 'copy' : 'reflink' }
  }
  if (verb === 'rm') {
    if (!pos[1]) throw new Error('rm needs <path>')
    fs.rmSync(pos[1], { recursive: true, force: true })
    return { removed: true }
  }
  if (verb === 'mv') {
    if (!pos[1] || !pos[2]) throw new Error('mv needs <src> <dst>')
    fs.renameSync(pos[1], pos[2])
    return { moved: true }
  }
  if (verb === 'stat') {
    const dir = pos[1]
    let exists = false
    let pgVersion = null
    try { exists = fs.statSync(dir).isDirectory() } catch { exists = false }
    try { pgVersion = fs.readFileSync(path.join(dir, 'PG_VERSION'), 'utf8').trim() } catch { pgVersion = null }
    return { exists, pgVersion }
  }
  if (verb === 'isempty') {
    const dir = pos[1]
    try { return { empty: fs.readdirSync(dir).length === 0 } }
    catch (e) { if (e.code === 'ENOENT') return { empty: true }; throw e }
  }
  throw new Error('unknown verb ' + (verb === undefined ? '' : verb))
}

try {
  process.stdout.write(JSON.stringify(main(process.argv.slice(2))))
} catch (e) {
  if (e instanceof NoReflink) {
    process.stderr.write('no reflink support: ' + e.message + '\n')
    process.exit(EXIT_NO_REFLINK)
  }
  if (e && DENIED.has(e.code)) {
    process.stderr.write('permission denied: ' + e.code + (e.path ? ' ' + e.path : '') + '\n')
    process.exit(EXIT_DENIED)
  }
  process.stderr.write(((e && e.stack) || e) + '\n')
  process.exit(1)
}
