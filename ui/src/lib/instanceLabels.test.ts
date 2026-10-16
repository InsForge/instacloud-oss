import { describe, expect, it } from 'vitest'
import { instanceLabel, instanceLabels } from './instanceLabels'

describe('instanceLabel', () => {
  it('reduces a compute container to its group and the default database to postgres', () => {
    expect(instanceLabel('io-demo-main-app-worker')).toBe('worker')
    expect(instanceLabel('io-demo-main-pg')).toBe('postgres')
    expect(instanceLabel(undefined)).toBe('')
  })

  it('leaves an extra database container raw', () => {
    expect(instanceLabel('io-demo-main-pg-analytics')).toBe('io-demo-main-pg-analytics')
    expect(instanceLabel('io-demo-main-rd-cache')).toBe('io-demo-main-rd-cache')
  })

  // Why there is no labelMatches any more: this collision is not resolvable from the label alone.
  // A postgres service NAMED "pg" and the branch's DEFAULT database both reduce to "postgres", so
  // any name-based filter either dropped the named service's own lines or mixed the two together.
  // Scoping happens at the daemon with `?group=` instead.
  it('cannot distinguish a service named pg from the default database, which is why filtering moved to the daemon', () => {
    expect(instanceLabel('io-demo-main-pg-pg')).toBe('postgres')
    expect(instanceLabel('io-demo-main-pg')).toBe('postgres')
  })
})

// The same non-injectivity is why metrics are keyed by the RAW container name: keying a record by
// the label made one of these two services overwrite the other, and it left the cards and every
// chart entirely. These labels are for display only.
describe('instanceLabels', () => {
  it('keeps two containers that share a label apart by showing the raw name', () => {
    const got = instanceLabels(['io-demo-main-pg', 'io-demo-main-pg-pg'])
    expect(got['io-demo-main-pg']).toBe('io-demo-main-pg')
    expect(got['io-demo-main-pg-pg']).toBe('io-demo-main-pg-pg')
    // Two distinct entries, not one: this is the property the old keying destroyed.
    expect(new Set(Object.values(got)).size).toBe(2)
  })

  it('uses the readable label when it is unambiguous', () => {
    const got = instanceLabels(['io-demo-main-pg', 'io-demo-main-app-worker', 'io-demo-main-rd-cache'])
    expect(got).toEqual({
      'io-demo-main-pg': 'postgres',
      'io-demo-main-app-worker': 'worker',
      'io-demo-main-rd-cache': 'io-demo-main-rd-cache',
    })
  })

  it('disambiguates only the colliding label, not the whole set', () => {
    const got = instanceLabels(['io-demo-main-pg', 'io-demo-main-pg-pg', 'io-demo-main-app-api'])
    expect(got['io-demo-main-app-api']).toBe('api')
    expect(got['io-demo-main-pg']).toBe('io-demo-main-pg')
  })

  it('is empty for no containers', () => {
    expect(instanceLabels([])).toEqual({})
  })

  // Falling back to the raw container name is not automatically unambiguous. A group may be NAMED
  // like another container: `--group io-demo-main-pg-analytics` is a valid lower-kebab name, and it
  // mints `io-demo-main-app-io-demo-main-pg-analytics`, whose label is the analytics database's own
  // raw name. Two cards reading exactly the same thing is the bug this function exists to prevent.
  it('never emits the same display value twice, even when a fallback collides with a label', () => {
    const instances = [
      'io-demo-main-pg',                                  // -> "postgres", collides
      'io-demo-main-pg-pg',                               // -> "postgres", collides
      'io-demo-main-app-io-demo-main-pg',                 // -> "io-demo-main-pg": the raw name above
    ]
    const got = instanceLabels(instances)
    const shown = Object.values(got)
    expect(new Set(shown).size).toBe(instances.length)
    // Every container still has an entry, and each is traceable to its container.
    expect(Object.keys(got).sort()).toEqual([...instances].sort())
  })

  it('leaves an unambiguous label alone while disambiguating its neighbours', () => {
    const got = instanceLabels(['io-demo-main-pg', 'io-demo-main-pg-pg', 'io-demo-main-app-api'])
    expect(got['io-demo-main-app-api']).toBe('api')
    expect(new Set(Object.values(got)).size).toBe(3)
  })
})
