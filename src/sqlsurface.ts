// What the ad-hoc query route may learn about a statement WITHOUT parsing SQL: its comments and
// string literals blanked out, so classification never trips over a `;` or an `update` that lives
// inside quoted text. Pure and small on purpose — this is a masking pass, not a parser, and the
// route's correctness never depends on it being right: a misclassified statement runs through the
// other transport and answers with postgres's own result or error, never a second execution.

/** Leading `--` and block comments off a statement, so a commented SELECT is still row-shaped. */
export function stripLeadingSqlComments(sql: string): string {
  let t = sql
  for (;;) {
    const next = t.replace(/^\s+/, '').replace(/^--[^\n]*\n?/, '').replace(/^\/\*[\s\S]*?\*\//, '')
    if (next === t) return t.trim()
    t = next
  }
}

/** The statement with every string literal, quoted identifier and comment blanked (kept the same
 *  length, so nothing shifts). Handles `'…'` with doubled quotes, `E'…'` with backslash escapes,
 *  `"…"` identifiers, `$tag$…$tag$` bodies, `--` line and `/* *​/` block comments (PG nests block
 *  comments; nesting is honoured). */
export function maskSqlText(sql: string): string {
  const out = sql.split('')
  const blank = (from: number, to: number): void => { for (let k = from; k < to && k < out.length; k++) if (!/\s/.test(out[k])) out[k] = ' ' }
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const two = sql.slice(i, i + 2)
    if (two === '--') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      blank(i, stop); i = stop
    } else if (two === '/*') {
      let depth = 1
      let j = i + 2
      while (j < sql.length && depth > 0) {
        if (sql.slice(j, j + 2) === '/*') { depth++; j += 2 } else if (sql.slice(j, j + 2) === '*/') { depth--; j += 2 } else j++
      }
      blank(i, j); i = j
    } else if (c === "'" || ((c === 'e' || c === 'E') && sql[i + 1] === "'")) {
      const escapes = c !== "'"
      let j = i + (escapes ? 2 : 1)
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') { j += 2; continue }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue } // doubled quote stays inside
          j++; break
        }
        j++
      }
      blank(i + (escapes ? 2 : 1), j - 1); i = j
    } else if (c === '"') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === '"') { if (sql[j + 1] === '"') { j += 2; continue } j++; break }
        j++
      }
      blank(i + 1, j - 1); i = j
    } else if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))
      if (m) {
        const tag = m[0]
        const close = sql.indexOf(tag, i + tag.length)
        const j = close === -1 ? sql.length : close + tag.length
        blank(i + tag.length, close === -1 ? j : close); i = j
      } else i++
    } else i++
  }
  return out.join('')
}

/** True when the masked text holds one statement: no `;` outside literals and comments, a trailing
 *  one aside. */
export function isSingleStatement(masked: string): boolean {
  return !masked.replace(/;+\s*$/, '').includes(';')
}

/** The last TOP-LEVEL DML/SELECT keyword in the masked text — how a WITH statement's shape is
 *  told: `with … select` returns rows, `with … update/insert/delete` is a command. Depth-aware,
 *  because `with c as (select 1) update t set v = (select 2)` ends in a nested SELECT while its
 *  top-level statement is the UPDATE; parens inside literals are already blanked by the mask. */
export function lastStatementKeyword(masked: string): string | null {
  let depth = 0
  let last: string | null = null
  const re = /[()]|\b(select|insert|update|delete)\b/gi
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    if (m[0] === '(') depth++
    else if (m[0] === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0) last = m[0].toLowerCase()
  }
  return last
}
