import { describe, expect, it } from 'vitest'
import { alwaysOnChoice, canSubmitCompute } from './alwaysOn'

describe('alwaysOnChoice', () => {
  it('never lets an untouched create go out while the branch is unknown (loading or failed)', () => {
    // The defect: the Add button stayed enabled here, the request omitted alwaysOn, and a
    // default-branch service came up always-on while the switch showed it off.
    for (const bootDefault of [true, false]) {
      const c = alwaysOnChoice({ picked: null, bootDefault, isDefaultBranch: undefined })
      expect(c.known).toBe(false)
      expect(c.send).toBeUndefined()
      expect(canSubmitCompute(c)).toBe(false)
    }
  })

  it('an explicit choice is always submittable, even when the branch could not be read', () => {
    for (const picked of [true, false]) {
      const c = alwaysOnChoice({ picked, bootDefault: true, isDefaultBranch: undefined })
      expect(c).toEqual({ value: picked, known: true, send: picked })
      expect(canSubmitCompute(c)).toBe(true)
    }
  })

  it('untouched, it shows what the branch will do and sends nothing', () => {
    // Default branch with the daemon's default on: always-on.
    expect(alwaysOnChoice({ picked: null, bootDefault: true, isDefaultBranch: true })).toEqual({ value: true, known: true, send: undefined })
    // Default branch with the daemon's default off: scale-to-zero.
    expect(alwaysOnChoice({ picked: null, bootDefault: false, isDefaultBranch: true })).toEqual({ value: false, known: true, send: undefined })
    // A preview branch scales to zero whatever the default is.
    expect(alwaysOnChoice({ picked: null, bootDefault: true, isDefaultBranch: false })).toEqual({ value: false, known: true, send: undefined })
    expect(canSubmitCompute(alwaysOnChoice({ picked: null, bootDefault: true, isDefaultBranch: false }))).toBe(true)
  })
})
