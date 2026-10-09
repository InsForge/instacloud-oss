import { describe, expect, it } from 'vitest'
import { copyText, type ClipboardEnv } from './clipboard'

/** A document whose execCommand('copy') succeeds or not, recording what happened. */
function fakeDocument(copies = true) {
  const log: string[] = []
  const area = { value: '', style: { position: '', opacity: '' }, setAttribute: () => {}, select: () => { log.push('select') } }
  const document: NonNullable<ClipboardEnv['document']> = {
    createElement: () => area,
    execCommand: (command) => { log.push(`${command}:${area.value}`); return copies },
    body: { appendChild: () => log.push('append'), removeChild: () => log.push('remove') },
  }
  return { log, document }
}

describe('copyText', () => {
  it('uses the Clipboard API when the page has it', async () => {
    const written: string[] = []
    const { log, document } = fakeDocument()
    const ok = await copyText('insta project link pr_1', { clipboard: { writeText: async (t) => { written.push(t) } }, document })
    expect(ok).toBe(true)
    expect(written).toEqual(['insta project link pr_1'])
    expect(log).toEqual([])
  })

  it('falls back to execCommand where there is no Clipboard API (plain HTTP is not a secure context)', async () => {
    const { log, document } = fakeDocument()
    expect(await copyText('insta project link pr_1', { document })).toBe(true)
    expect(log).toEqual(['append', 'select', 'copy:insta project link pr_1', 'remove'])
  })

  it('falls back when the Clipboard API refuses', async () => {
    const { log, document } = fakeDocument()
    const ok = await copyText('x', { clipboard: { writeText: async () => { throw new Error('denied') } }, document })
    expect(ok).toBe(true)
    expect(log).toContain('copy:x')
  })

  it('reports a copy that did not take, so the chip never says "Copied" for it', async () => {
    const { log, document } = fakeDocument(false)
    expect(await copyText('x', { document })).toBe(false)
    expect(log.at(-1)).toBe('remove')
    expect(await copyText('x', {})).toBe(false)
  })
})
