// The data-dir copy helper (src/fsclone.cjs) is what carries user data across a fork: a compute
// /data volume through the `clone` verb, a Postgres data directory through `clone --pg`. It runs as
// a short-lived child process with two engines, `ficlone` on Linux and `cp-c` on macOS, so it is
// exercised here the way the daemon runs it: argv in, JSON out, on a real temporary directory with
// the engine this platform actually uses.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { NoReflinkError } from '../src/types'
import { isHelperRetryable, translateCloneError } from '../src/datadir'

const HELPER = new URL('../src/fsclone.cjs', import.meta.url).pathname
const ENGINE = process.platform === 'darwin' ? 'cp-c' : 'ficlone'

let root = ''

const clone = (src: string, dst: string, extra: string[] = []): { method: string; files: number } => {
  const out = execFileSync(process.execPath, [HELPER, 'clone', src, dst, '--reflink=auto', `--engine=${ENGINE}`, ...extra], { encoding: 'utf8' })
  return JSON.parse(out) as { method: string; files: number }
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fsclone-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

test('clone puts the CONTENTS of the source under the destination, not the source directory', () => {
  const src = join(root, 'vol-id')
  mkdirSync(join(src, 'sub'), { recursive: true })
  writeFileSync(join(src, 'marker'), 'forked\n')
  writeFileSync(join(src, 'sub', 'nested'), 'deep\n')
  const dst = join(root, 'copy-id')
  mkdirSync(dst, { recursive: true })   // forkVolumes creates it before copying

  const res = clone(src, dst)

  expect(readFileSync(join(dst, 'marker'), 'utf8')).toBe('forked\n')
  expect(readFileSync(join(dst, 'sub', 'nested'), 'utf8')).toBe('deep\n')
  // The bug this pins: `cp -a src/. dst/` on BSD cp nested the source directory one level down,
  // so the branch's container mounted an empty /data with a single directory in it.
  expect(readdirSync(dst).sort()).toEqual(['marker', 'sub'])
  expect(readdirSync(dst)).not.toContain(basename(src))
  expect(res.files).toBeGreaterThan(0)
})

test('clone recreates a symlink as a symlink and copies a dotfile', () => {
  const src = join(root, 'src')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'real'), 'target\n')
  writeFileSync(join(src, '.hidden'), 'dot\n')
  symlinkSync('real', join(src, 'link'))
  const dst = join(root, 'dst')

  clone(src, dst)

  expect(readdirSync(dst).sort()).toEqual(['.hidden', 'link', 'real'])
  expect(readFileSync(join(dst, 'link'), 'utf8')).toBe('target\n')
})

test('clone --pg copies a data directory, PG_VERSION included, and stat reads it back', () => {
  const src = join(root, 'pg-main')
  mkdirSync(join(src, 'base'), { recursive: true })
  writeFileSync(join(src, 'PG_VERSION'), '16\n')
  writeFileSync(join(src, 'base', 'page'), 'x'.repeat(1024))
  const dst = join(root, 'pg-feat')

  clone(src, dst, ['--pg'])

  expect(readFileSync(join(dst, 'PG_VERSION'), 'utf8')).toBe('16\n')
  expect(readFileSync(join(dst, 'base', 'page'), 'utf8').length).toBe(1024)
  const stat = JSON.parse(execFileSync(process.execPath, [HELPER, 'stat', dst], { encoding: 'utf8' })) as { exists: boolean; pgVersion: string | null }
  expect(stat).toEqual({ exists: true, pgVersion: '16' })
})

test('isempty distinguishes an empty directory from a missing one and from a full one', () => {
  const empty = join(root, 'empty')
  mkdirSync(empty)
  const full = join(root, 'full')
  mkdirSync(full)
  writeFileSync(join(full, 'f'), 'x')
  const read = (dir: string): { empty: boolean } =>
    JSON.parse(execFileSync(process.execPath, [HELPER, 'isempty', dir], { encoding: 'utf8' })) as { empty: boolean }

  expect(read(empty).empty).toBe(true)
  expect(read(join(root, 'missing')).empty).toBe(true)
  expect(read(full).empty).toBe(false)
})

// ---- the permission answer, and what the daemon makes of it ----
//
// `runLocal` in src/datadir.ts runs this program as a CHILD PROCESS, and a promisified `execFile`
// rejection carries the child's EXIT STATUS in `e.code`, never the child's errno. A permission
// refusal that exits 1 therefore reached the daemon as the string "1", matched neither the helper
// codes nor the no-reflink codes, and propagated raw: on an unprivileged Linux daemon meeting a
// PGDATA the postgres image chowned 0700 to its own uid, `branch create` failed outright under
// INSTA_OSS_FORK=auto instead of streaming pg_basebackup, and printed `Command failed:` instead of
// the refusal message under INSTA_OSS_FORK=reflink. The exit code is the carrier that survives.

/** Root reads through mode 0000, so there is no refusal to observe. */
const asRoot = process.getuid?.() === 0

test.skipIf(asRoot)('a source it cannot read exits 77, not 1: that is what the helper fallback keys on', () => {
  const src = join(root, 'locked')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'PG_VERSION'), '16\n')
  chmodSync(src, 0o000)
  try {
    const r = spawnSync(process.execPath, [HELPER, 'clone', src, join(root, 'copy'), '--reflink=auto', `--engine=${ENGINE}`], { encoding: 'utf8' })
    expect(r.status).toBe(77)
    expect(r.stderr).toContain('permission denied')
    expect(r.stderr).toContain('EACCES')
    // Not the no-reflink code: a refusal to read is not a filesystem that cannot clone, and the two
    // send the caller down different paths (helper retry vs pg_basebackup).
    expect(r.status).not.toBe(75)
  } finally {
    chmodSync(src, 0o700)
  }
})

test('exit 77 becomes the EACCES-coded error the helper fallback retries; exit 75 stays a NoReflinkError', () => {
  // Shaped exactly like a promisified execFile rejection: the child's exit status lands in `code`.
  const childExit = (status: number, stderr: string): Error =>
    Object.assign(new Error(`Command failed: node fsclone.cjs clone ...\n${stderr}`), { code: status })

  const denied = translateCloneError(childExit(77, 'permission denied: EACCES /var/lib/instacloud/pg/demo-main/db'))
  expect(isHelperRetryable(denied)).toBe(true)
  expect(denied).not.toBeInstanceOf(NoReflinkError)

  // The other exit code keeps its own meaning, and a plain failure keeps passing through untouched.
  expect(translateCloneError(childExit(75, 'no reflink support: ENOTSUP'))).toBeInstanceOf(NoReflinkError)
  const other = childExit(1, 'ENOSPC: no space left on device')
  expect(translateCloneError(other)).toBe(other)
  expect(isHelperRetryable(translateCloneError(other))).toBe(false)

  // The helper container reports the same thing through `docker`, whose message carries the exit.
  const viaDocker = new Error('docker run --rm -i ... -> exit 77: permission denied: EPERM')
  expect(isHelperRetryable(translateCloneError(viaDocker))).toBe(true)
})
