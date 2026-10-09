import { describe, expect, it } from 'vitest'
import { readDraftName, writeDraftName } from './settingsDraft'

describe('the Settings name draft', () => {
  it('outlives the panel: a draft written before Back unmounts it is read again on the next open', () => {
    writeDraftName('p1', 'renamed-but-unsaved')
    expect(readDraftName('p1')).toBe('renamed-but-unsaved')
  })

  it('is forgotten on Save or Discard', () => {
    writeDraftName('p2', 'draft')
    writeDraftName('p2', null)
    expect(readDraftName('p2')).toBeNull()
  })

  it("never shows one project's draft in another's Settings", () => {
    writeDraftName('p3', 'only-p3')
    expect(readDraftName('p4')).toBeNull()
  })
})
