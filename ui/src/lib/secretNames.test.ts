import { describe, expect, it } from 'vitest'
import { newSecretNameError } from './secretNames'

describe('newSecretNameError', () => {
  it('accepts environment variable names, lowercase included', () => {
    for (const name of ['API_KEY', 'STRIPE_SECRET', '_PRIVATE', 'database_url', 'a1', 'X']) {
      expect(newSecretNameError(name), name).toBeNull()
    }
  })
  it('requires a name', () => {
    expect(newSecretNameError('')).toBe('A name is required.')
  })
  it('refuses spaces, punctuation, a leading digit and "="', () => {
    for (const name of ['bad name', 'API-KEY', 'API.KEY', '1ST_KEY', 'KEY=1', 'kéy', 'KEY$']) {
      expect(newSecretNameError(name), name).toBe('Use letters, digits and underscores, not starting with a digit (like API_KEY).')
    }
  })
})
