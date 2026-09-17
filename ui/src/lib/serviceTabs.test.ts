import { describe, expect, it } from 'vitest'
import { TAB_LABELS, tabsFor, type TabId } from './serviceTabs'

describe('tabsFor', () => {
  it('gives compute the full rail, Volume included', () => {
    expect(tabsFor('compute')).toEqual(['metrics', 'variables', 'runtime', 'volume', 'settings'])
  })

  it('gives postgres a Database tab and no Volume', () => {
    expect(tabsFor('postgres')).toEqual(['database', 'metrics', 'variables', 'runtime', 'settings'])
  })

  // The round-1 Critical: the daemon's volume read AND write both refuse every non-compute
  // service, so a Volume tab here could only ever show "volumes are only supported for compute
  // services" and an attach could never succeed.
  it.each(['redis', 'mysql', 'mongodb'])('gives %s no Volume tab, because the daemon has none', (type) => {
    expect(tabsFor(type)).toEqual(['metrics', 'variables', 'runtime', 'settings'])
    expect(tabsFor(type)).not.toContain('volume')
  })

  it('leads storage with the Buckets file browser; an unknown type gets the minimum', () => {
    expect(tabsFor('storage')).toEqual(['buckets', 'variables', 'settings'])
    expect(tabsFor('something-new')).toEqual(['variables', 'settings'])
  })

  it('only ever names storage as bucket-bearing', () => {
    const withBuckets = ['compute', 'postgres', 'redis', 'mysql', 'mongodb', 'storage', 'unknown']
      .filter((t) => tabsFor(t).includes('buckets'))
    expect(withBuckets).toEqual(['storage'])
  })

  it('only ever names compute as volume-bearing', () => {
    const withVolume = ['compute', 'postgres', 'redis', 'mysql', 'mongodb', 'storage']
      .filter((t) => tabsFor(t).includes('volume'))
    expect(withVolume).toEqual(['compute'])
  })

  it('every tab it can return has a label, and every tab list is unique and non-empty', () => {
    for (const type of ['compute', 'postgres', 'redis', 'mysql', 'mongodb', 'storage', 'unknown']) {
      const tabs = tabsFor(type)
      expect(tabs.length, type).toBeGreaterThan(0)
      expect(new Set(tabs).size, type).toBe(tabs.length)
      for (const t of tabs) expect(TAB_LABELS[t as TabId], `${type}/${t}`).toBeTruthy()
    }
  })
})
