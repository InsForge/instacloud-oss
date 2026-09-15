import { describe, expect, it } from 'vitest'
import { API_TOKEN_ENV, cliLine, cliSteps } from './quickStart'

const URL = 'http://127.0.0.1:8081'

describe('cliSteps', () => {
  it('splits the setup into one command per step, local mode', () => {
    expect(cliSteps('pr_1', 'local', URL)).toEqual([
      'npm install -g insta',
      `export INSTA_API_URL=${URL}`,
      'insta project link pr_1',
    ])
  })
  it('signs in with the API token variable in server mode', () => {
    expect(cliSteps('pr_1', 'server', URL)).toEqual([
      'npm install -g insta',
      `insta login --api-key "$${API_TOKEN_ENV}" --api-url ${URL}`,
      'insta project link pr_1',
    ])
  })
  it('is exactly what the one-line Quick Start copy chains', () => {
    for (const mode of ['local', 'server'] as const) {
      expect(cliLine('pr_1', mode, URL)).toBe(cliSteps('pr_1', mode, URL).join(' && '))
    }
  })
  it('never uses `setup agent`, in any step', () => {
    for (const mode of ['local', 'server'] as const) {
      expect(cliSteps('pr_1', mode, URL).some((s) => s.includes('setup agent'))).toBe(false)
    }
  })
})
