import { describe, expect, it } from 'vitest'
import { addableFor, attachmentsFor } from './serviceAttachments'

describe('attachmentsFor', () => {
  it('shows a compute volume as the console does, opening the Volume tab', () => {
    expect(attachmentsFor({ type: 'compute', volume_gib: 10 })).toEqual([{ kind: 'volume', label: 'Volume', meta: '10 GB', tab: 'volume' }])
  })

  it('shows a managed database volume, opening the default tab: it has no Volume tab here', () => {
    expect(attachmentsFor({ type: 'redis', volume_gib: 1 })).toEqual([{ kind: 'volume', label: 'Volume', meta: '1 GB', tab: null }])
  })

  it('draws no row for a service with no volume size', () => {
    expect(attachmentsFor({ type: 'compute', volume_gib: null })).toEqual([])
    expect(attachmentsFor({ type: 'compute' })).toEqual([])
    expect(attachmentsFor({ type: 'postgres' })).toEqual([])
  })

  it('draws no row for a size that is not a positive number', () => {
    expect(attachmentsFor({ type: 'compute', volume_gib: 0 })).toEqual([])
    expect(attachmentsFor({ type: 'compute', volume_gib: Number.NaN })).toEqual([])
  })
})

describe('addableFor', () => {
  it('offers "+ Add Volume" on a compute service with no volume, opening its Volume tab', () => {
    expect(addableFor({ type: 'compute', volume_gib: null })).toEqual([{ kind: 'volume', label: 'Volume', tab: 'volume' }])
    expect(addableFor({ type: 'compute' })).toEqual([{ kind: 'volume', label: 'Volume', tab: 'volume' }])
  })

  it('offers nothing once the volume is mounted: the card shows its row instead', () => {
    expect(addableFor({ type: 'compute', volume_gib: 10 })).toEqual([])
  })

  it('offers nothing where the detail has no Volume tab, so the slot always has somewhere to go', () => {
    expect(addableFor({ type: 'postgres' })).toEqual([])
    expect(addableFor({ type: 'redis', volume_gib: null })).toEqual([])
    expect(addableFor({ type: 'storage' })).toEqual([])
  })
})
