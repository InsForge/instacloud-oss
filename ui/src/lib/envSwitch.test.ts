import { describe, expect, it } from 'vitest'
import { envBadge, subpageForSwitch } from './envSwitch'

describe('subpageForSwitch', () => {
  it('keeps the page you are on', () => {
    expect(subpageForSwitch('/p/abc/main/secrets')).toBe('secrets')
    expect(subpageForSwitch('/p/abc/main/observability')).toBe('observability')
  })

  it('lands a service detail on the other environment’s list, not on a foreign id', () => {
    expect(subpageForSwitch('/p/abc/feat/services/4af7a685:cp-web')).toBe('services')
  })

  it('defaults to the services list', () => {
    expect(subpageForSwitch('/p/abc/main')).toBe('services')
    expect(subpageForSwitch('/')).toBe('services')
  })
})

describe('envBadge', () => {
  it('names the role, and Failed for a branch that is not usable', () => {
    expect(envBadge({ is_default: true, status: 'active' }).label).toBe('Prod')
    expect(envBadge({ is_default: false, status: 'active' }).label).toBe('Preview')
    expect(envBadge({ is_default: false, status: 'cleanup-failed' }).label).toBe('Failed')
    expect(envBadge({ is_default: true, status: 'error' }).label).toBe('Failed')
  })
})
