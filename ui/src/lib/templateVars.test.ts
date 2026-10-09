import { describe, expect, it } from 'vitest'
import { applyMissing, canSubmit, flattenVariables, isSecretName, mustFill, payloadVariables, placeholderFor } from './templateVars'

describe('flattenVariables', () => {
  it('puts required first, keeps manifest order, and de-duplicates by name with required OR-ed', () => {
    const flat = flattenVariables({
      variables: {
        required: [{ name: 'ADMIN_USERNAME', description: 'u' }, { name: 'ADMIN_PASSWORD' }],
        optional: [{ name: 'OPENROUTER_API_KEY' }, { name: 'ADMIN_USERNAME', description: 'dup' }, { name: 'TELEGRAM_BOT_TOKEN' }],
      },
    })
    expect(flat.map((v) => v.name)).toEqual(['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'OPENROUTER_API_KEY', 'TELEGRAM_BOT_TOKEN'])
    expect(flat[0]).toMatchObject({ required: true, description: 'u', mustFill: true })
    expect(flat[2]).toMatchObject({ required: false, mustFill: false })
  })

  it('a name declared optional first and required later becomes required', () => {
    const flat = flattenVariables({
      variables: { required: [{ name: 'B' }], optional: [{ name: 'A', required: true }, { name: 'C' }] },
    })
    expect(flat.map((v) => [v.name, v.required])).toEqual([['B', true], ['A', true], ['C', false]])
  })

  it('tolerates missing groups and junk entries', () => {
    expect(flattenVariables({})).toEqual([])
    expect(flattenVariables({ variables: null })).toEqual([])
    expect(flattenVariables({ variables: { required: [{ name: '' } as never] } })).toEqual([])
  })
})

describe('mustFill / placeholderFor', () => {
  it('required with no generator and no default must be typed', () => {
    expect(mustFill({ required: true })).toBe(true)
    expect(mustFill({ required: true, generate: 'secret:32' })).toBe(false)
    expect(mustFill({ required: true, default: 'x' })).toBe(false)
    expect(mustFill({ required: true, default: '' })).toBe(false)
    expect(mustFill({ required: false })).toBe(false)
    expect(mustFill({ required: true, generate: null })).toBe(true)
    expect(mustFill({ required: true, generate: '' })).toBe(true)
  })

  it('placeholders explain what happens when left blank', () => {
    const base = { name: 'X', required: false, mustFill: false }
    expect(placeholderFor({ ...base, generate: 'secret:16' })).toBe('generated on deploy')
    expect(placeholderFor({ ...base, default: '5678' })).toBe('default: 5678')
    expect(placeholderFor({ ...base, generate: 'secret:16', default: 'x' })).toBe('generated on deploy')
    expect(placeholderFor(base)).toBe('')
  })
})

describe('isSecretName', () => {
  it('matches credential-looking env names', () => {
    for (const n of ['ADMIN_PASSWORD', 'JWT_SECRET', 'TELEGRAM_BOT_TOKEN', 'OPENROUTER_API_KEY', 'SIGNING_KEY', 'PRIVATE_PEM', 'db_password']) {
      expect(isSecretName(n)).toBe(true)
    }
  })
  it('does not match plain configuration', () => {
    for (const n of ['ADMIN_USERNAME', 'N8N_PORT', 'KEYBOARD_LAYOUT', 'TOKENIZER']) {
      expect(isSecretName(n)).toBe(n === 'TOKENIZER')
    }
  })
})

describe('canSubmit / payloadVariables', () => {
  const vars = flattenVariables({
    variables: { required: [{ name: 'A' }, { name: 'G', generate: 'secret:8' }], optional: [{ name: 'O' }] },
  })
  it('requires every must-fill variable to be non-blank', () => {
    expect(canSubmit(vars, {})).toBe(false)
    expect(canSubmit(vars, { A: '  ' })).toBe(false)
    expect(canSubmit(vars, { A: 'x' })).toBe(true)
    expect(canSubmit(vars, { A: 'x', G: '', O: '' })).toBe(true)
  })
  it('drops blank values and keeps the rest verbatim', () => {
    expect(payloadVariables({ A: 'x', G: '', O: '   ', P: ' keep me ' })).toEqual({ A: 'x', P: ' keep me ' })
    expect(payloadVariables({})).toEqual({})
  })
})

describe('applyMissing', () => {
  it('reads name, else key, from the 400 missing_variables body', () => {
    expect(applyMissing({ error: 'missing_variables', missing: [{ name: 'A', key: 'a' }, { key: 'B' }, { description: 'no id' }] })).toEqual(['A', 'B'])
  })
  it('accepts plain strings and de-duplicates', () => {
    expect(applyMissing({ missing: ['A', 'A', { name: 'A' }, ''] })).toEqual(['A'])
  })
  it('returns nothing for any other body', () => {
    expect(applyMissing({ error: 'nope' })).toEqual([])
    expect(applyMissing(null)).toEqual([])
    expect(applyMissing({ missing: 'A' })).toEqual([])
  })
})
