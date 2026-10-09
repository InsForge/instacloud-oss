// The managed-database and object-store adapters' removal contracts, plus the object store's
// LAYOUT probe, over injected seams.
//
// `test/postgres-adapter.test.ts` pins the same three-way through `LocalPostgres.destroy`; this
// file covers the other two implementations of it. The adapter layer is where a failed removal
// used to become an already-absent one, and every teardown above it deletes bind-mounted data
// and drops the row that names it the moment destroy returns, so each answer is pinned rather
// than assumed: dockerd's own not-found is absence, an ambiguous error is re-checked, and a
// probe that cannot answer is not evidence of anything.
import { test, expect, vi } from 'vitest'

const calls: string[][] = []
/** Errors keyed by the first two argv words, so a case can fail exactly one docker call. */
let failures: Array<{ match: (args: string[]) => boolean; error: string }> = []

vi.mock('../src/docker', async (orig) => ({
  ...(await orig<typeof import('../src/docker')>()),
  docker: vi.fn(async (args: string[]) => {
    calls.push([...args])
    const hit = failures.find((f) => f.match(args))
    if (hit) throw new Error(hit.error)
    return Buffer.from('')
  }),
}))

import { LocalManagedDb } from '../src/adapters/manageddb'
import { LocalGarage } from '../src/adapters/garage'

const reset = (): void => { calls.length = 0; failures = [] }
const fail = (match: (args: string[]) => boolean, error: string): void => { failures.push({ match, error }) }
const isRm = (a: string[]): boolean => a[0] === 'rm'
const isInspect = (a: string[]): boolean => a[0] === 'inspect'

// ---- managed databases (redis | mysql | mongodb) -----------------------------------------------

test('managed destroy: dockerd saying there is no such container is absence', async () => {
  reset()
  fail(isRm, 'Error: No such object: io-demo-feat-rd-cache')
  await expect(new LocalManagedDb().destroy('io-demo-feat-rd-cache')).resolves.toBeUndefined()
  expect(calls.filter(isInspect)).toEqual([])   // dockerd answered; no probe needed
})

test('managed destroy: an ambiguous failure with the container gone is absence', async () => {
  reset()
  fail(isRm, 'Error response from daemon: removal already in progress')
  fail(isInspect, 'Error: No such object: io-demo-feat-rd-cache')
  await expect(new LocalManagedDb().destroy('io-demo-feat-rd-cache')).resolves.toBeUndefined()
  expect(calls.filter(isInspect)).toHaveLength(1)
})

test('managed destroy: a container that is STILL THERE raises, so its bytes are not deleted', async () => {
  reset()
  fail(isRm, 'Error response from daemon: container is in use')
  // `inspect` answers, so the container exists.
  await expect(new LocalManagedDb().destroy('io-demo-feat-rd-cache')).rejects.toThrow(/container is in use/)
})

test('managed destroy: a probe that cannot answer is not absence', async () => {
  reset()
  fail(isRm, 'Error response from daemon: removal already in progress')
  fail(isInspect, 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock')
  await expect(new LocalManagedDb().destroy('io-demo-feat-rd-cache')).rejects.toThrow(/removal already in progress/)
})

// ---- the object store --------------------------------------------------------------------------
//
// Garage's shape is its own: the evidence is its bucket LIST, not a container probe, so the
// shared helper does not fit and it is tested on its own terms.

const garage = (): LocalGarage => new LocalGarage({
  configPath: '/tmp/garage.toml', hostEndpoint: 'http://127.0.0.1:3900', mode: 'local', domain: 'localhost',
})
const isBucketDelete = (a: string[]): boolean => a.join(' ').includes('bucket delete')
const isBucketList = (a: string[]): boolean => a.join(' ').includes('bucket list')

test('bucket destroy: a delete that succeeded needs no list', async () => {
  reset()
  await expect(garage().destroy('io-demo-feat-store', 'io-demo-feat')).resolves.toBeUndefined()
  expect(calls.filter(isBucketList)).toEqual([])
})

test('bucket destroy: a failed delete with the bucket gone from the list is absence', async () => {
  reset()
  fail(isBucketDelete, 'garage: bucket not found')
  // The list answers without naming it, so it really is gone.
  await expect(garage().destroy('io-demo-feat-store', 'io-demo-feat')).resolves.toBeUndefined()
  expect(calls.filter(isBucketList)).toHaveLength(1)
})

test('bucket destroy: a failed delete with the bucket STILL LISTED raises', async () => {
  reset()
  const real = (await import('../src/docker')).docker
  vi.mocked(real).mockImplementation(async (args: string[]) => {
    calls.push([...args])
    if (isBucketDelete(args)) throw new Error('garage: bucket is not empty')
    if (isBucketList(args)) return Buffer.from('io-demo-main-store\nio-demo-feat-store\n')
    return Buffer.from('')
  })
  await expect(garage().destroy('io-demo-feat-store', 'io-demo-feat'))
    .rejects.toThrow(/could not delete bucket io-demo-feat-store/)
})

test('bucket destroy: a list that cannot answer is not absence', async () => {
  reset()
  const real = (await import('../src/docker')).docker
  vi.mocked(real).mockImplementation(async (args: string[]) => {
    calls.push([...args])
    if (isBucketDelete(args)) throw new Error('garage: rpc error')
    if (isBucketList(args)) throw new Error('garage: rpc error')
    return Buffer.from('')
  })
  await expect(garage().destroy('io-demo-feat-store', 'io-demo-feat')).rejects.toThrow(/could not delete bucket/)
})


// ---- the object store's layout probe -----------------------------------------------------------
//
// Same rule, a different probe: `initLayout` decided "this node already has a role" by the
// ABSENCE of the string `NO ROLE ASSIGNED` in `garage status`, so any output it could not parse
// -- a changed format, an empty capture, a partially written buffer -- skipped the layout
// initialisation on a store the daemon then reports as ready.

/** A `garage status` node table, in the v2 shape: a banner, a header row, then node rows. */
const statusWith = (row: string): string => [
  '==== HEALTHY NODES ====',
  'ID                Hostname  Address         Tags  Zone  Capacity  DataAvail',
  row,
  '',
].join('\n')
const NODE = 'a1b2c3d4e5f60718'
const isStatus = (a: string[]): boolean => a.includes('status')
const isAssign = (a: string[]): boolean => a.join(' ').includes('layout assign')

const withStatus = async (status: string): Promise<void> => {
  const real = (await import('../src/docker')).docker
  vi.mocked(real).mockImplementation(async (args: string[]) => {
    calls.push([...args])
    if (isStatus(args)) return Buffer.from(status)
    return Buffer.from('')
  })
}

test('garage layout: an UNPARSEABLE status raises instead of assuming a role is assigned', async () => {
  reset()
  await withStatus('')
  await expect(garage().provision('demo-main', 'io-demo-main', 'store'))
    .rejects.toThrow(/could not read the Garage node list/)
  expect(calls.filter(isAssign)).toEqual([])
})

test('garage layout: a node with NO ROLE ASSIGNED is assigned one', async () => {
  reset()
  await withStatus(statusWith(`${NODE}  box  127.0.0.1:3901  []  NO ROLE ASSIGNED`))
  await garage().provision('demo-main', 'io-demo-main', 'store').catch(() => { /* the rest is mocked away */ })
  expect(calls.filter(isAssign).map((a) => a[a.length - 1])).toEqual([NODE])
})

test('garage layout: a node that already carries a role is left alone', async () => {
  reset()
  await withStatus(statusWith(`${NODE}  box  127.0.0.1:3901  []  dc1  100.0 GB  95.0 GB`))
  await garage().provision('demo-main', 'io-demo-main', 'store').catch(() => { /* the rest is mocked away */ })
  expect(calls.filter(isAssign)).toEqual([])
})
