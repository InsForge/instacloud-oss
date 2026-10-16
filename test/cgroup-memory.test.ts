// What the scheduler believes about memory, from the two sources it has. `cgroupMemory` reads
// THIS process's own cgroup v2 ceiling, which is the only thing that can tell an instad inside a
// container how much room it really has: /proc/meminfo describes the machine. `hostMemory` reads
// the machine, and adds back the one large reclaimable pool the kernel's own MemAvailable does
// not count.
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { arcReclaimable, cgroupMemory, hostMemory } from '../src/scheduler'

const dirs: string[] = []

function cgroup(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'io-cgroup-'))
  dirs.push(dir)
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

test('an unlimited cgroup answers null, so /proc/meminfo stands', () => {
  expect(cgroupMemory(cgroup({ 'memory.max': 'max\n', 'memory.current': '1000\n' }))).toBeNull()
})

test('a machine with no cgroup v2 files answers null', () => {
  expect(cgroupMemory(join(tmpdir(), 'io-cgroup-does-not-exist'))).toBeNull()
})

test('a ceiling answers total and available, counting reclaimable cache as free', () => {
  const dir = cgroup({
    'memory.max': `${512 * 1024 * 1024}\n`,
    'memory.current': `${400 * 1024 * 1024}\n`,
    'memory.stat': `anon ${300 * 1024 * 1024}\ninactive_file ${80 * 1024 * 1024}\nslab_reclaimable ${20 * 1024 * 1024}\n`,
  })
  expect(cgroupMemory(dir)).toEqual({
    totalBytes: 512 * 1024 * 1024,
    availableBytes: 212 * 1024 * 1024,     // 512 - 400 + 80 + 20
  })
})

test('available never exceeds the ceiling and never goes below zero', () => {
  const roomy = cgroup({
    'memory.max': `${100}\n`,
    'memory.current': `${10}\n`,
    'memory.stat': `inactive_file ${1000}\n`,
  })
  expect(cgroupMemory(roomy)?.availableBytes).toBe(100)
  const full = cgroup({ 'memory.max': `${100}\n`, 'memory.current': `${400}\n`, 'memory.stat': 'inactive_file 0\n' })
  expect(cgroupMemory(full)?.availableBytes).toBe(0)
})

test('a missing memory.stat still yields a reading, counting cache as used', () => {
  const dir = cgroup({ 'memory.max': `${1000}\n`, 'memory.current': `${250}\n` })
  expect(cgroupMemory(dir)).toEqual({ totalBytes: 1000, availableBytes: 750 })
})

test('a garbled ceiling answers null rather than a nonsense reading', () => {
  expect(cgroupMemory(cgroup({ 'memory.max': 'nope\n', 'memory.current': '1\n' }))).toBeNull()
  expect(cgroupMemory(cgroup({ 'memory.max': '0\n', 'memory.current': '1\n' }))).toBeNull()
  expect(cgroupMemory(cgroup({ 'memory.max': '1000\n', 'memory.current': 'nope\n' }))).toBeNull()
})


// ---- the machine, and the ZFS ARC ---------------------------------------------------------------
//
// On Linux the ARC is not page cache: it comes from the SPL's own caches and scatter ABDs, so it
// lands in neither term the kernel sums into MemAvailable, yet the shrinker gives it back down to
// `c_min` under pressure. A ZFS host with a warm ARC therefore reads as permanently under the RAM
// floor, and this daemon would evict continuously on a box that is fine.

const MiB = 1024 * 1024

/** A `/proc` with the files a case wants in it. */
function proc(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'io-proc-'))
  dirs.push(dir)
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body)
  }
  return dir
}

const meminfo = (totalKb: number, availableKb: number): string => [
  `MemTotal:       ${totalKb} kB`,
  `MemFree:        ${Math.floor(availableKb / 2)} kB`,
  `MemAvailable:   ${availableKb} kB`,
  'Buffers:            1024 kB',
  '',
].join('\n')

/** Real `arcstats` shape: two header lines, then `name  type  data`. */
const arcstats = (size: number, cMin: number): string => [
  '13 1 0x01 98 26656 5424128000 66403655280',
  'name                            type data',
  'hits                            4    1234567',
  'misses                          4    89012',
  `c_min                           4    ${cMin}`,
  'c_max                           4    8589934592',
  `size                            4    ${size}`,
  'hdr_size                        4    12345678',
  'data_size                       4    987654321',
  '',
].join('\n')

test('the ARC parser reads size and c_min out of real arcstats text', () => {
  const dir = proc({ 'spl/kstat/zfs/arcstats': arcstats(3000 * MiB, 512 * MiB) })
  expect(arcReclaimable(dir)).toBe(2488 * MiB)
})

test('a machine with no ZFS has no ARC, and an unreadable one is not an error', () => {
  // Absent file: a box without ZFS must be bit for bit unaffected by any of this.
  expect(arcReclaimable(proc({ meminfo: meminfo(1, 1) }))).toBe(0)
  expect(arcReclaimable(join(tmpdir(), 'io-proc-does-not-exist'))).toBe(0)
  // Unparseable: the safe direction is the SMALLER number, so 0 rather than a throw. A probe
  // that cannot answer must not be the thing that switches the floor off.
  expect(arcReclaimable(proc({ 'spl/kstat/zfs/arcstats': 'garbage\nnot a kstat\n' }))).toBe(0)
  // An ARC already at its floor gives nothing back.
  expect(arcReclaimable(proc({ 'spl/kstat/zfs/arcstats': arcstats(512 * MiB, 512 * MiB) }))).toBe(0)
})

test('a warm ARC counts as available, so a ZFS box under a floor does NOT evict', () => {
  // 8 GiB box, MemAvailable 800 MiB, ARC 3 GiB of which 2.5 GiB is above c_min. Against a 15%
  // floor (1228 MiB) the raw reading is under and the true one is comfortably over: this is the
  // arithmetic that decided to evict, every sweep, on a machine with nothing wrong with it.
  const total = 8192 * MiB
  const floor = total * 0.15
  const withZfs = proc({
    meminfo: meminfo(8192 * 1024, 800 * 1024),
    'spl/kstat/zfs/arcstats': arcstats(3072 * MiB, 512 * MiB),
  })
  const read = hostMemory(withZfs)!
  expect(read.totalBytes).toBe(total)
  expect(read.availableBytes).toBe(800 * MiB + 2560 * MiB)
  expect(read.availableBytes).toBeGreaterThan(floor)          // no eviction

  // The same box without ZFS reads exactly what the kernel said, and is under the floor.
  const noZfs = hostMemory(proc({ meminfo: meminfo(8192 * 1024, 800 * 1024) }))!
  expect(noZfs).toEqual({ totalBytes: total, availableBytes: 800 * MiB })
  expect(noZfs.availableBytes).toBeLessThan(floor)
})

test('available never exceeds total, however large the ARC reads', () => {
  // The clamp is what bounds the damage if a future OpenZFS ever accounted the ARC into
  // MemAvailable itself: double counting would then be capped rather than unbounded.
  const dir = proc({
    meminfo: meminfo(2048 * 1024, 1500 * 1024),
    'spl/kstat/zfs/arcstats': arcstats(4096 * MiB, 0),
  })
  expect(hostMemory(dir)).toEqual({ totalBytes: 2048 * MiB, availableBytes: 2048 * MiB })
})

test('a meminfo that cannot be read or parsed answers null, as before', () => {
  expect(hostMemory(join(tmpdir(), 'io-proc-does-not-exist'))).toBeNull()
  expect(hostMemory(proc({ meminfo: 'MemTotal:       8192 kB\n' }))).toBeNull()   // no MemAvailable
})
