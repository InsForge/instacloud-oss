// SQL the Database tab's Data browser sends through the query route (the console's data view,
// insta-frontend database/data-tab.tsx). Pure so the identifier quoting carries a test: the table
// list comes back from the SERVER, and a table name is an identifier, not a value — `"` doubling
// is the one escape that holds for every name Postgres itself accepts.

/** Every user table, schema-qualified, for the Data tab's table rail. */
export const TABLES_SQL =
  "select table_schema as schema, table_name as name from information_schema.tables " +
  "where table_schema not in ('pg_catalog', 'information_schema') and table_type = 'BASE TABLE' order by 1, 2"

/** A quoted identifier: doubled inner quotes, always wrapped. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

export const DATA_TAB_LIMIT = 100

/** The first rows of one table, bounded (the Data tab is a browser, not an exporter). */
export function tableRowsSql(schema: string, name: string, limit = DATA_TAB_LIMIT): string {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 1000)
  return `select * from ${quoteIdent(schema)}.${quoteIdent(name)} limit ${n}`
}

/** A result cell as the grid prints it: null stays visibly null, objects stay JSON. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
