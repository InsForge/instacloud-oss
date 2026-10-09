// `DataDir`'s two destructive verbs against a REAL filesystem: what `remove` and `rename` accept
// as "inside the data directory".
//
// Both are called with paths built from state rows (teardown from a branch row, the boot
// migration's promotion from a layout computed off a ref), so the guard in front of them is the
// only thing between a bad row and the rest of the box. The lexical half of it was covered by the
// paths the engine already builds; this file covers the half a string test cannot see, a symlinked
// component, with actual links on disk rather than a lexical `..`.
import { test, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataDir } from '../src/datadir'
import { loadConfig } from '../src/config'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A data dir and, beside it, an "outside" directory holding one file nothing may touch. */
function box(): { dd: DataDir; dataDir: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), 'io-dd-'))
  made.push(base)
  const dataDir = join(base, 'data')
  const outside = join(base, 'outside')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  mkdirSync(outside, { recursive: true, mode: 0o700 })
  writeFileSync(join(outside, 'precious.txt'), 'do not touch')
  const cfg = loadConfig({ INSTA_OSS_MODE: 'local', INSTA_OSS_DATA_DIR: dataDir, INSTA_OSS_STATE: join(dataDir, 'state.json') }, [])
  return { dd: new DataDir(cfg), dataDir, outside }
}

test('the lexical guard still holds: nothing outside the data dir, and never the data dir itself', async () => {
  const { dd, dataDir, outside } = box()
  await expect(dd.remove(outside)).rejects.toThrow(/outside the data dir/)
  await expect(dd.remove(join(dataDir, '..', 'outside'))).rejects.toThrow(/outside the data dir/)
  await expect(dd.remove(dataDir)).rejects.toThrow(/refusing to remove the data dir itself/)
  expect(existsSync(join(outside, 'precious.txt'))).toBe(true)
})

test('a SYMLINKED ancestor cannot be walked through by remove', async () => {
  const { dd, dataDir, outside } = box()
  // `vol/escape` spells out a path under the data dir, and `resolve()` agrees, but it is a link.
  mkdirSync(join(dataDir, 'vol'), { recursive: true })
  symlinkSync(outside, join(dataDir, 'vol', 'escape'))

  await expect(dd.remove(join(dataDir, 'vol', 'escape', 'precious.txt'))).rejects.toThrow(/is a symlink/)
  await expect(dd.remove(join(dataDir, 'vol', 'escape'))).rejects.toThrow(/is a symlink/)
  expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('do not touch')
})

test('a rename is refused when the DESTINATION passes through a symlink, and nothing moves', async () => {
  const { dd, dataDir, outside } = box()
  // The migration's shape: a staged copy inside the data dir, promoted with one rename.
  const staging = join(dataDir, 'pg', 'demo-main', '.incoming-db')
  mkdirSync(staging, { recursive: true })
  writeFileSync(join(staging, 'PG_VERSION'), '16')
  mkdirSync(join(dataDir, 'vol'), { recursive: true })
  symlinkSync(outside, join(dataDir, 'vol', 'escape'))

  await expect(dd.rename(staging, join(dataDir, 'vol', 'escape', 'promoted'))).rejects.toThrow(/is a symlink/)
  // The promotion did not happen anywhere: not outside, and not by leaving the staging gone.
  expect(existsSync(join(outside, 'promoted'))).toBe(false)
  expect(readFileSync(join(staging, 'PG_VERSION'), 'utf8')).toBe('16')
})

test('a rename is refused when the SOURCE passes through a symlink', async () => {
  const { dd, dataDir, outside } = box()
  symlinkSync(outside, join(dataDir, 'linked'))
  const target = join(dataDir, 'pg', 'demo-main', 'db')
  mkdirSync(join(dataDir, 'pg', 'demo-main'), { recursive: true })

  await expect(dd.rename(join(dataDir, 'linked', 'precious.txt'), target)).rejects.toThrow(/is a symlink/)
  expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('do not touch')
  expect(existsSync(target)).toBe(false)
})

test('an ordinary path inside the data dir still removes and renames', async () => {
  const { dd, dataDir } = box()
  const staging = join(dataDir, 'pg', 'demo-main', '.incoming-db')
  const target = join(dataDir, 'pg', 'demo-main', 'db')
  mkdirSync(staging, { recursive: true })
  writeFileSync(join(staging, 'PG_VERSION'), '16')

  await dd.rename(staging, target)
  expect(readFileSync(join(target, 'PG_VERSION'), 'utf8')).toBe('16')
  expect(existsSync(staging)).toBe(false)

  await dd.remove(target)
  expect(existsSync(target)).toBe(false)
  // A path that does not exist is not an error: teardown calls this for roots a branch never had.
  await dd.remove(join(dataDir, 'vol', 'demo-main'))
})

test('a data dir that is ITSELF a symlink is the operator\'s own choice and still works', async () => {
  const base = mkdtempSync(join(tmpdir(), 'io-dd-'))
  made.push(base)
  const real = join(base, 'real')
  const link = join(base, 'link')
  mkdirSync(real, { recursive: true, mode: 0o700 })
  symlinkSync(real, link)
  const cfg = loadConfig({ INSTA_OSS_MODE: 'local', INSTA_OSS_DATA_DIR: link, INSTA_OSS_STATE: join(link, 'state.json') }, [])
  const dd = new DataDir(cfg)

  const staging = join(link, 'pg', 'demo-main', '.incoming-db')
  mkdirSync(staging, { recursive: true })
  writeFileSync(join(staging, 'PG_VERSION'), '16')
  await dd.rename(staging, join(link, 'pg', 'demo-main', 'db'))
  expect(readFileSync(join(real, 'pg', 'demo-main', 'db', 'PG_VERSION'), 'utf8')).toBe('16')
})
