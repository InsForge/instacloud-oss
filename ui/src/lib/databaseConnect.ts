// The Connect Database dialog's strings (insta-frontend lib/database-connect.ts): the connection URL with its password
// masked, a raw client line derived from it, and the `insta run` wrapper. Pure so the root vitest covers it.
//
// Self-host divergence: the console reads a managed database's `{PREFIX}_PUBLIC_URL`, which exists only with Public
// Access on, and otherwise points at that toggle. The daemon's credentials route already answers the host-facing lane
// address, which a client on this machine can reach, so the URL is always offered.

const MASK = '•••••••'

export type DbConnectEngine = 'postgres' | 'mysql' | 'redis' | 'mongodb'
export const DB_CONNECT_ENGINES: readonly DbConnectEngine[] = ['postgres', 'mysql', 'redis', 'mongodb']

export const RAW_COMMAND_LABEL: Record<DbConnectEngine, string> = {
  postgres: 'Raw psql command',
  mysql: 'Raw mysql command',
  redis: 'Raw redis-cli command',
  mongodb: 'Raw mongosh command',
}

export function isDbConnectEngine(type: string): type is DbConnectEngine {
  return (DB_CONNECT_ENGINES as readonly string[]).includes(type)
}

/** Single-quote a shell word, closing around embedded quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The DSN with its password swapped for dots, so the row can sit open without leaking. */
export function maskDsn(dsn: string): string {
  try {
    const url = new URL(dsn)
    if (!url.password) return dsn
    return dsn.replace(`:${url.password}@`, `:${MASK}@`)
  } catch {
    return MASK
  }
}

type Command = { full: string; masked: string }

/** psql in flag form, the password in PGPASSWORD so the visible command is safe to leave on screen. Flag form drops
 *  the DSN's query, so its `sslmode` rides in PGSSLMODE: a server-mode lane answers `?sslmode=require` and its Postgres
 *  router refuses a connection without TLS. */
export function psqlCommand(dsn: string): Command | null {
  try {
    const url = new URL(dsn)
    const user = decodeURIComponent(url.username)
    if (!user) return null
    const db = decodeURIComponent(url.pathname.replace(/^\//, '')) || user
    const sslmode = url.searchParams.get('sslmode')
    const ssl = sslmode ? `PGSSLMODE=${shellQuote(sslmode)} ` : ''
    const base = `psql -h ${url.hostname} -p ${url.port || '5432'} -U ${user} -d ${db}`
    if (!url.password) return { full: `${ssl}${base}`, masked: `${ssl}${base}` }
    return {
      full: `${ssl}PGPASSWORD=${shellQuote(decodeURIComponent(url.password))} ${base}`,
      masked: `${ssl}PGPASSWORD=${MASK} ${base}`,
    }
  } catch {
    return null
  }
}

/** mysql has no URL form: flags, with the password in MYSQL_PWD. */
export function mysqlCommand(url: string): Command | null {
  try {
    const u = new URL(url)
    const user = decodeURIComponent(u.username)
    if (!user) return null
    const db = decodeURIComponent(u.pathname.replace(/^\//, ''))
    const base = `mysql -h ${u.hostname} -P ${u.port || '3306'} -u ${user}${db ? ` ${db}` : ''}`
    if (!u.password) return { full: base, masked: base }
    return { full: `MYSQL_PWD=${shellQuote(decodeURIComponent(u.password))} ${base}`, masked: `MYSQL_PWD=${MASK} ${base}` }
  } catch {
    return null
  }
}

/** redis-cli takes the URL with -u, one shell-quoted token. */
export function redisCliCommand(url: string): Command | null {
  try { new URL(url) } catch { return null }
  return { full: `redis-cli -u ${shellQuote(url)}`, masked: `redis-cli -u ${shellQuote(maskDsn(url))}` }
}

/** mongosh takes the URL positionally. */
export function mongoshCommand(url: string): Command | null {
  try { new URL(url) } catch { return null }
  return { full: `mongosh ${shellQuote(url)}`, masked: `mongosh ${shellQuote(maskDsn(url))}` }
}

/** The engine's raw client command for a connection URL, or null when the URL does not parse. */
export function dbRawCommand(engine: DbConnectEngine, url: string): Command | null {
  switch (engine) {
    case 'postgres': return psqlCommand(url)
    case 'mysql': return mysqlCommand(url)
    case 'redis': return redisCliCommand(url)
    case 'mongodb': return mongoshCommand(url)
  }
}

/** The credential a connection URL is read from: Postgres's `DATABASE_URL`, a managed database's `{PREFIX}_URL`
 *  (src/manageddb.ts `laneBundle`), both already host-facing. */
const URL_KEY: Record<DbConnectEngine, string> = {
  postgres: 'DATABASE_URL', mysql: 'MYSQL_URL', redis: 'REDIS_URL', mongodb: 'MONGODB_URL',
}

/** The connectable URL out of a service's credential bundle, or null when the bundle carries none. */
export function connectUrlFor(engine: DbConnectEngine, credentials: Record<string, string> | null | undefined): string | null {
  const value = credentials?.[URL_KEY[engine]]
  return typeof value === 'string' && value ? value : null
}

/** Wrap a raw client line so it runs inside an InstaCloud branch. */
export function instaCliRun(branch: string, command: string): string {
  return `insta run --branch ${shellQuote(branch)} -- sh -c ${shellQuote(command)}`
}
