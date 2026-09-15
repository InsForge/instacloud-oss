import { describe, expect, it } from 'vitest'
import { dbGateView } from './dbWakeGate'

describe('dbGateView', () => {
  it('shows the content of an awake database', () => {
    expect(dbGateView({ sleeping: false, waking: false, awaitingRead: false })).toBe('content')
  })
  it('prompts for a sleeping database nobody has asked to wake', () => {
    expect(dbGateView({ sleeping: true, waking: false, awaitingRead: false })).toBe('prompt')
  })
  it('connects while the wake request is in flight', () => {
    expect(dbGateView({ sleeping: true, waking: true, awaitingRead: false })).toBe('connecting')
  })
  it('keeps connecting after a successful wake until a read answers (no flash of the prompt)', () => {
    // The row the flash came from: the wake returned, the reloaded read has not answered yet.
    expect(dbGateView({ sleeping: true, waking: false, awaitingRead: true })).toBe('connecting')
  })
  it('lets the first read after the wake decide: awake shows content, asleep again prompts (never spins forever)', () => {
    expect(dbGateView({ sleeping: false, waking: false, awaitingRead: false })).toBe('content')
    // Asleep again by the time the read landed: the prompt, not an endless "Connecting".
    expect(dbGateView({ sleeping: true, waking: false, awaitingRead: false })).toBe('prompt')
  })
  it('prompts when the wake itself failed', () => {
    expect(dbGateView({ sleeping: true, waking: false, awaitingRead: true, wakeError: 'could not make room' })).toBe('prompt')
  })
})
