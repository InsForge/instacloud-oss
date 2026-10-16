import { describe, expect, it } from 'vitest'
import { cellText, quoteIdent, tableRowsSql } from './sqlBrowse'

describe('quoteIdent', () => {
  it('always wraps, doubling inner quotes', () => {
    expect(quoteIdent('users')).toBe('"users"')
    expect(quoteIdent('weird"name')).toBe('"weird""name"')
    expect(quoteIdent('a";drop table t;--')).toBe('"a"";drop table t;--"')
  })
})

describe('tableRowsSql', () => {
  it('schema-qualifies and bounds the limit', () => {
    expect(tableRowsSql('public', 'users')).toBe('select * from "public"."users" limit 100')
    expect(tableRowsSql('public', 'users', 5000)).toBe('select * from "public"."users" limit 1000')
    expect(tableRowsSql('public', 'users', 0)).toBe('select * from "public"."users" limit 1')
  })
  it('a hostile table name stays an identifier', () => {
    expect(tableRowsSql('public', 'u"; drop table x; --')).toBe('select * from "public"."u""; drop table x; --" limit 100')
  })
})

describe('cellText', () => {
  it('NULL for null/undefined, JSON for objects, text otherwise', () => {
    expect(cellText(null)).toBe('NULL')
    expect(cellText(undefined)).toBe('NULL')
    expect(cellText({ a: 1 })).toBe('{"a":1}')
    expect(cellText([1, 2])).toBe('[1,2]')
    expect(cellText(0)).toBe('0')
    expect(cellText(false)).toBe('false')
  })
})
