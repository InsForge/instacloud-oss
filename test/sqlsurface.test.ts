import { test, expect } from 'vitest'
import { isSingleStatement, lastStatementKeyword, maskSqlText, stripLeadingSqlComments, trailingTrimIndex } from '../src/sqlsurface'

test('stripLeadingSqlComments: line and block comments fall off, the statement stays', () => {
  expect(stripLeadingSqlComments('-- note\nselect 1')).toBe('select 1')
  expect(stripLeadingSqlComments('/* a */ /* b */\n-- c\nselect 1')).toBe('select 1')
  expect(stripLeadingSqlComments('select 1 -- trailing stays')).toBe('select 1 -- trailing stays')
})

test('maskSqlText blanks literals, identifiers and comments but nothing else', () => {
  expect(maskSqlText("select 'a;b' as v")).toBe("select '   ' as v")
  expect(maskSqlText('select "we;ird" from t')).toBe('select "      " from t')
  expect(maskSqlText("select 'it''s;fine'")).toBe("select '          '")
  expect(maskSqlText("select E'a\\';b'")).toBe("select E'     '")
  expect(maskSqlText('select $x$ a;b $x$')).toBe('select $x$     $x$')
  expect(maskSqlText('select 1 -- a;b')).toBe('select 1       ')
  expect(maskSqlText('select /* x /* y */ z */ 1')).toBe('select                   1')
})

test('isSingleStatement: semicolons in literals and trailing ones do not split', () => {
  expect(isSingleStatement(maskSqlText("select 'a;b' as v;"))).toBe(true)
  expect(isSingleStatement(maskSqlText('select 1; select 2'))).toBe(false)
  // A terminal `;` shadowed by a trailing comment is still terminal.
  expect(isSingleStatement(maskSqlText('select 1; -- done'))).toBe(true)
  expect(isSingleStatement(maskSqlText('select 1; /* done */'))).toBe(true)
  expect(isSingleStatement(maskSqlText('select 1; ; -- done'))).toBe(true)
})

test('trailingTrimIndex slices the terminator off the ORIGINAL text, comments included', () => {
  const cut = (sql) => sql.slice(0, trailingTrimIndex(maskSqlText(sql)))
  expect(cut('select 1; -- done')).toBe('select 1')
  expect(cut('select 1; /* done */')).toBe('select 1')
  expect(cut("select 'a;' as v;")).toBe("select 'a;' as v")
})

test('lastStatementKeyword tells a WITH…SELECT from a WITH…UPDATE, ignoring quoted text', () => {
  expect(lastStatementKeyword(maskSqlText('with a as (select 1) select * from a'))).toBe('select')
  expect(lastStatementKeyword(maskSqlText('with d as (select 1) update t set a = 1'))).toBe('update')
  expect(lastStatementKeyword(maskSqlText("select 'please update me' as note"))).toBe('select')
  // Depth-aware: a nested SELECT after the top-level UPDATE must not flip the verdict.
  expect(lastStatementKeyword(maskSqlText('with c as (select 1) update t set v = (select 2)'))).toBe('update')
  expect(lastStatementKeyword(maskSqlText('select (select 1), (select 2)'))).toBe('select')
  // A WITH whose final query is parenthesized has NO top-level keyword — the caller reads null
  // as "a query expression", which is the only thing parentheses can hold there.
  expect(lastStatementKeyword(maskSqlText('with x as (select 1) (select * from x)'))).toBe(null)
})
