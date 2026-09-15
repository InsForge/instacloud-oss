import { describe, expect, it } from 'vitest'
import { copyRowKey, isCopyConfirmed } from './copyConfirm'

const cli = ['npm install -g insta', 'export INSTA_API_URL=http://127.0.0.1:8081', 'insta project link pr_1']
const prompt = 'Connect this repo to my self-hosted InstaCloud at http://127.0.0.1:8081: …'

describe('copy confirmation', () => {
  it('confirms only the row that was copied', () => {
    const copied = copyRowKey('cli', cli[0])
    expect(isCopyConfirmed(copied, 'cli', cli[0])).toBe(true)
    expect(isCopyConfirmed(copied, 'cli', cli[1])).toBe(false)
    expect(isCopyConfirmed(null, 'cli', cli[0])).toBe(false)
  })
  it('does not carry across a mode switch (the reported bug), in either direction', () => {
    // Copy CLI step 1, switch to Use Prompt: the prompt row, also the first row, is not confirmed.
    expect(isCopyConfirmed(copyRowKey('cli', cli[0]), 'prompt', prompt)).toBe(false)
    // Copy the prompt, switch to Use CLI: step 1 is not confirmed.
    expect(isCopyConfirmed(copyRowKey('prompt', prompt), 'cli', cli[0])).toBe(false)
  })
  it('keys differ by mode even for the same text, and between rows of one mode', () => {
    expect(copyRowKey('cli', 'x')).not.toBe(copyRowKey('prompt', 'x'))
    expect(new Set(cli.map((row) => copyRowKey('cli', row))).size).toBe(cli.length)
  })
})
