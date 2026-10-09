import { describe, expect, it } from 'vitest'
import { isTerminal, normalizeServices, soleUrl, statusLine, stepMarks } from './deployment'

describe('stepMarks', () => {
  it('marks earlier steps done, the current one active, later ones pending', () => {
    expect(stepMarks('running', 'create_services')).toEqual(['active', 'pending', 'pending', 'pending'])
    expect(stepMarks('running', 'deploy')).toEqual(['done', 'done', 'active', 'pending'])
  })
  it('a succeeded run marks every step done regardless of the recorded step', () => {
    expect(stepMarks('succeeded', 'health_check')).toEqual(['done', 'done', 'done', 'done'])
    expect(stepMarks('succeeded', undefined)).toEqual(['done', 'done', 'done', 'done'])
  })
  it('a failed or partial run marks the step it died on as failed', () => {
    expect(stepMarks('failed', 'deploy')).toEqual(['done', 'done', 'failed', 'pending'])
    expect(stepMarks('partial', 'health_check')).toEqual(['done', 'done', 'done', 'failed'])
  })
  it('an unknown step is pending while running and failed when the run ended', () => {
    expect(stepMarks('running', 'nope')).toEqual(['pending', 'pending', 'pending', 'pending'])
    expect(stepMarks('failed', undefined)).toEqual(['failed', 'failed', 'failed', 'failed'])
  })
})

describe('normalizeServices', () => {
  it('accepts the cloud array view', () => {
    expect(normalizeServices([{ name: 'n8n', state: 'healthy', url: 'https://n8n-x.test', serviceId: 'cp-n8n' }])).toEqual([
      { name: 'n8n', state: 'healthy', url: 'https://n8n-x.test', serviceId: 'cp-n8n' },
    ])
  })
  it('accepts the stored record form keyed by name', () => {
    expect(normalizeServices({ web: { serviceName: 'web', state: 'created' }, db: { state: 'pending' } })).toEqual([
      { name: 'web', state: 'created', url: undefined, serviceId: undefined },
      { name: 'db', state: 'pending', url: undefined, serviceId: undefined },
    ])
  })
  it('defaults an unknown state to pending and drops junk', () => {
    expect(normalizeServices([{ name: 'a', state: 'weird' }, null, 'x', {}])).toEqual([{ name: 'a', state: 'pending', url: undefined, serviceId: undefined }])
    expect(normalizeServices(undefined)).toEqual([])
  })
})

describe('soleUrl / isTerminal / statusLine', () => {
  it('offers Open service only when exactly one url exists', () => {
    expect(soleUrl([{ name: 'a', state: 'healthy', url: 'https://a' }, { name: 'b', state: 'healthy' }])).toBe('https://a')
    expect(soleUrl([{ name: 'a', state: 'healthy', url: 'https://a' }, { name: 'b', state: 'healthy', url: 'https://b' }])).toBeUndefined()
    expect(soleUrl([])).toBeUndefined()
  })
  it('knows the terminal statuses', () => {
    expect(isTerminal('succeeded')).toBe(true)
    expect(isTerminal('partial')).toBe(true)
    expect(isTerminal('running')).toBe(false)
    expect(isTerminal(undefined)).toBe(false)
  })
  it('has a line per status', () => {
    expect(statusLine('succeeded')).toBe('Deployed.')
    expect(statusLine('running')).toMatch(/Deploying/)
    expect(statusLine('nope')).toBe('')
  })
})
