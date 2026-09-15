import { describe, expect, it } from 'vitest'
import { settingsTabFrom, withoutPanel, withSettings } from './panels'

describe('settingsTabFrom', () => {
  it('names the tab, and falls back to General for a missing or unknown value', () => {
    expect(settingsTabFrom('agent-governance')).toBe('agent-governance')
    expect(settingsTabFrom('general')).toBe('general')
    expect(settingsTabFrom(null)).toBe('general')
    expect(settingsTabFrom('billing')).toBe('general')
  })
})

describe('withSettings', () => {
  it('opens Settings on General without a settings-tab, as the console does', () => {
    expect(withSettings('')).toBe('?panel=settings')
    expect(withSettings('?settings-tab=agent-governance')).toBe('?panel=settings')
  })

  it('opens another tab by name', () => {
    expect(withSettings('', 'agent-governance')).toBe('?panel=settings&settings-tab=agent-governance')
  })

  it('keeps an open service detail underneath', () => {
    expect(withSettings('?service=cp-web&tab=metrics')).toBe('?service=cp-web&tab=metrics&panel=settings')
  })
})

describe('withoutPanel', () => {
  it('closes the panel and drops its own params only', () => {
    expect(withoutPanel('?service=cp-web&panel=settings&settings-tab=agent-governance')).toBe('?service=cp-web')
    expect(withoutPanel('?panel=settings')).toBe('')
  })
})
