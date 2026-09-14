// autoFit is ported from insta-frontend src/lib/canvas-layout.test.ts; the saved-position cases cover
// the dashboard's store, which goes through localPrefStore (blocked storage must not break the canvas).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { autoFit, clearPositions, loadPositions, positionsKey, savePositions, snapToGrid } from './canvasLayout'

/**
 * The camera-following rule, not the rendering: the canvas re-fits as the layout
 * settles (bindings arrive after mount and reshape it), and every way that could
 * overrule a placement the user is actually looking at.
 */
describe('autoFit', () => {
  it('fits without a glide the first time, since there is nothing to glide from', () => {
    expect(autoFit(false, null, 'a@0,0')).toEqual({ fit: true, animate: false })
  })

  it('glides when the layout moves under an untouched camera', () => {
    expect(autoFit(false, 'a@0,0', 'a@0,285')).toEqual({ fit: true, animate: true })
  })

  it('does nothing when the layout has not moved', () => {
    expect(autoFit(false, 'a@0,0', 'a@0,0').fit).toBe(false)
  })

  it('leaves a claimed camera alone even when the layout moves', () => {
    expect(autoFit(true, 'a@0,0', 'a@0,285').fit).toBe(false)
  })
})

describe('dragged card positions', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const memoryStorage = () => {
    const store = new Map<string, string>()
    return { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } }
  }

  it("uses the console's key shape, per project and environment", () => {
    expect(positionsKey('p1', 'main')).toBe('insta-canvas:p1:main')
  })

  it('snaps a drop to the dot lattice', () => {
    expect(snapToGrid(37)).toBe(48)
    expect(snapToGrid(-13)).toBe(-24)
  })

  it('saves, loads back, and clears', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() })
    const key = positionsKey('p-save', 'main')
    savePositions(key, { 'cp-app': { x: 480, y: 0 } })
    expect(loadPositions(key)).toEqual({ 'cp-app': { x: 480, y: 0 } })
    clearPositions(key)
    expect(loadPositions(key)).toEqual({})
  })

  it('drops malformed entries instead of placing a card at NaN', () => {
    const storage = memoryStorage()
    vi.stubGlobal('window', { localStorage: storage })
    const key = positionsKey('p-malformed', 'main')
    storage.setItem(key, JSON.stringify({ good: { x: 24, y: 48 }, bad: { x: 'left' }, worse: null }))
    expect(loadPositions(key)).toEqual({ good: { x: 24, y: 48 } })
    storage.setItem(key, '{not json')
    expect(loadPositions(key)).toEqual({})
  })

  it('keeps working when site data is blocked', () => {
    vi.stubGlobal('window', { localStorage: { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') }, removeItem() { throw new Error('blocked') } } })
    const key = positionsKey('p-blocked', 'main')
    expect(() => savePositions(key, { a: { x: 0, y: 0 } })).not.toThrow()
    expect(loadPositions(key)).toEqual({ a: { x: 0, y: 0 } }) // held for this page, as localPref does
  })
})
