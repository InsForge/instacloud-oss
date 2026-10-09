import { describe, expect, it } from 'vitest'
import { NESTED_LAYER_ROLES, OPEN_NESTED_LAYER_SELECTOR } from './nestedLayers'

describe('OPEN_NESTED_LAYER_SELECTOR', () => {
  it('covers dialogs, menus and listboxes', () => {
    expect([...NESTED_LAYER_ROLES].sort()).toEqual(['alertdialog', 'dialog', 'listbox', 'menu'])
  })
  it('matches each role only while open', () => {
    const parts = OPEN_NESTED_LAYER_SELECTOR.split(',')
    expect(parts).toContain('[role="menu"][data-state="open"]')
    expect(parts).toContain('[role="listbox"][data-state="open"]')
    expect(parts).toContain('[role="dialog"][data-state="open"]')
    expect(parts).toContain('[role="alertdialog"][data-state="open"]')
    expect(parts.every((p) => p.endsWith('[data-state="open"]'))).toBe(true)
  })
})
