import { describe, expect, it } from 'vitest'
import { formatVolumeGib, sizeBounds, sizeError } from './volumeSize'

describe('sizeBounds', () => {
  it('starts an unattached disk at the minimum and runs to the cap', () => {
    expect(sizeBounds(null, 100)).toEqual({ floor: 1, max: 100, atCeiling: false })
  })
  it('floors an attached disk at its own size (grow-only)', () => {
    expect(sizeBounds({ sizeGib: 10 }, 100)).toEqual({ floor: 10, max: 100, atCeiling: false })
  })
  it('is at the ceiling when the disk already fills the cap, or sits above it', () => {
    expect(sizeBounds({ sizeGib: 100 }, 100).atCeiling).toBe(true)
    expect(sizeBounds({ sizeGib: 120 }, 100)).toEqual({ floor: 120, max: 120, atCeiling: true })
  })
})

describe('sizeError', () => {
  const grown = sizeBounds({ sizeGib: 10 }, 100)
  it('accepts a whole size inside the bounds', () => {
    expect(sizeError('10', grown)).toBeNull()
    expect(sizeError(' 100 ', grown)).toBeNull()
  })
  it('refuses a fraction, text and an empty field', () => {
    expect(sizeError('10.5', grown)).toBe('Enter a whole number of GB.')
    expect(sizeError('ten', grown)).toBe('Enter a whole number of GB.')
    expect(sizeError('', grown)).toBe('Enter a whole number of GB.')
  })
  it('refuses a shrink, and says why, and a size over the cap', () => {
    expect(sizeError('9', grown)).toBe('A volume can only grow: 10 GB or more.')
    expect(sizeError('0', sizeBounds(null, 100))).toBe('At least 1 GB.')
    expect(sizeError('101', grown)).toBe('At most 100 GB.')
  })
  it('formats as the console does', () => {
    expect(formatVolumeGib(20)).toBe('20 GB')
  })
})
