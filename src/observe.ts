// Docker/SQL-backed observability: the CLOUD's response shapes (LogsResult / MetricsResult /
// DbMetricsSnapshot / DbActivityRow / DbQueryStats — see platform openapi) served from local
// signals — `docker logs`/`docker stats` for runtime, plain SQL over the branch database for DB
// insight. Pure parsing/mapping helpers live here so they unit-test without docker or Postgres.

export interface LogLine { ts: string; level?: string; message: string; instance?: string }
export interface LogsResult { source: string; lines: LogLine[]; note?: string }
export interface MetricSeries { name: string; unit?: string; labels?: Record<string, string>; points: Array<[number, number]> }
export interface MetricsResult { source: string; series: MetricSeries[]; note?: string }

export interface DbOperation { id: string; action: string; status: string; durationMs?: number; createdAt?: string }
export interface DbConnections { active: number; idle: number; total: number; max: number }
export interface DbMetricsSnapshot {
  connections: DbConnections; dbSizeBytes: number; deadlocks: number
  tuples: { inserted: number; updated: number; deleted: number }; cacheHitRatio: number
}
export interface DbActivityRow {
  pid: number; state?: string; waitEvent?: string; durationMs?: number
  query?: string; application?: string; client?: string; queryStart?: string
}
export interface DbQueryStatRow { queryId: string; query: string; calls: number; meanMs: number; totalMs: number; rows: number }
export interface DbQueryStats { stats: DbQueryStatRow[]; extensionReady: boolean }
export type QueryStatSort = 'total' | 'mean' | 'calls'

/** Parse `docker logs --timestamps` output: "2026-07-22T01:02:03.456789Z message". */
export function parseDockerLogs(raw: string, instance: string): LogLine[] {
  return raw.split('\n').filter(Boolean).map((line) => {
    const sp = line.indexOf(' ')
    const ts = sp > 0 ? line.slice(0, sp) : ''
    const stamped = /^\d{4}-\d{2}-\d{2}T/.test(ts)
    return { ts: stamped ? ts : '', message: stamped ? line.slice(sp + 1) : line, instance }
  })
}

/** "12.34MiB" / "1.2GB" → bytes (docker stats humanized units). */
export function parseSize(s: string): number {
  const m = /^([\d.]+)\s*([A-Za-z]+)?$/.exec(s.trim())
  if (!m) return 0
  const mult: Record<string, number> = {
    b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
  }
  return Number(m[1]) * (mult[(m[2] ?? 'b').toLowerCase()] ?? 1)
}


// ---- SQL over the branch database (mirrors the platform's neon-sql.ts queries + keys) ----

export const DB_METRICS_SQL = `select row_to_json(t) from (
  select
    (select count(*) from pg_stat_activity where datname = current_database())::int as total,
    (select count(*) from pg_stat_activity where datname = current_database() and state = 'active')::int as active,
    (select count(*) from pg_stat_activity where datname = current_database() and state = 'idle')::int as idle,
    current_setting('max_connections')::int as max,
    pg_database_size(current_database())::bigint as db_size_bytes,
    d.deadlocks::bigint as deadlocks,
    d.tup_inserted::bigint as inserted, d.tup_updated::bigint as updated, d.tup_deleted::bigint as deleted,
    d.blks_hit::bigint as blks_hit, d.blks_read::bigint as blks_read
  from pg_stat_database d where d.datname = current_database()) t`

export const DB_ACTIVITY_SQL = `select coalesce(json_agg(t), '[]'::json) from (
  select pid, state, wait_event as "waitEvent",
         extract(epoch from (now() - query_start)) * 1000 as "durationMs",
         query, application_name as application, host(client_addr) as client,
         to_char(query_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "queryStart"
  from pg_stat_activity
  where datname = current_database() and state is not null and state <> 'idle' and pid <> pg_backend_pid()
  order by query_start asc nulls last limit 100) t`

const SORT_COLUMNS: Record<QueryStatSort, string> = { total: 'total_exec_time', mean: 'mean_exec_time', calls: 'calls' }

export function queryStatsSql(limit: number, sort: QueryStatSort): string {
  const col = SORT_COLUMNS[sort] ?? SORT_COLUMNS.total // whitelisted → safe to interpolate
  const n = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100)
  return `select coalesce(json_agg(t), '[]'::json) from (
    select s.queryid::text as "queryId", s.query, s.calls::bigint as calls,
           s.total_exec_time as "totalMs", s.mean_exec_time as "meanMs", s.rows::bigint as rows
    from pg_stat_statements s join pg_database d on d.oid = s.dbid
    where d.datname = current_database()
    order by s.${col} desc nulls last limit ${n}) t`
}

const num = (v: unknown): number => Number(v ?? 0)

export function toDbMetrics(rowJson: string): DbMetricsSnapshot {
  const r = JSON.parse(rowJson || '{}') as Record<string, unknown>
  const hit = num(r.blks_hit), read = num(r.blks_read), reads = hit + read
  return {
    connections: { active: num(r.active), idle: num(r.idle), total: num(r.total), max: num(r.max) },
    dbSizeBytes: num(r.db_size_bytes),
    deadlocks: num(r.deadlocks),
    tuples: { inserted: num(r.inserted), updated: num(r.updated), deleted: num(r.deleted) },
    cacheHitRatio: reads > 0 ? hit / reads : 0,
  }
}

export function toDbActivity(rowsJson: string): DbActivityRow[] {
  const rows = JSON.parse(rowsJson || '[]') as Array<Record<string, unknown>>
  return rows.map((r) => ({
    pid: num(r.pid),
    state: (r.state as string) ?? undefined,
    waitEvent: (r.waitEvent as string) ?? undefined,
    durationMs: r.durationMs == null ? undefined : Number(r.durationMs),
    query: (r.query as string) ?? undefined,
    application: (r.application as string) ?? undefined,
    client: (r.client as string) ?? undefined,
    queryStart: (r.queryStart as string) ?? undefined,
  }))
}

export function toQueryStats(rowsJson: string): DbQueryStatRow[] {
  const rows = JSON.parse(rowsJson || '[]') as Array<Record<string, unknown>>
  return rows.map((r) => ({
    queryId: String(r.queryId ?? ''), query: String(r.query ?? ''),
    calls: num(r.calls), totalMs: num(r.totalMs), meanMs: num(r.meanMs), rows: num(r.rows),
  }))
}

/** Postgres refuses pg_stat_statements reads unless the library is preloaded — that (or a missing
 *  extension) means "not available here", distinct from a connection failure. */
export function isExtensionUnavailable(message: string): boolean {
  return /pg_stat_statements|shared_preload_libraries|does not exist/i.test(message)
}

// ---- database management + insight (contract parity with the cloud's DbInsight/DbExtensionsView) ----

export const DB_DATABASES_SQL = `select coalesce(json_agg(t), '[]'::json) from (
  select datname as name from pg_database where not datistemplate order by datname) t`

export const DB_EXTENSIONS_SQL = `select json_build_object(
  'available', (select coalesce(json_agg(a order by a.name), '[]'::json) from (
     select name from pg_available_extensions) a),
  'enabled', (select coalesce(json_agg(extname order by extname), '[]'::json) from pg_extension))`

export const DB_INSIGHT_SQL = `select json_build_object(
  'sizes', json_build_object(
     'databaseBytes', pg_database_size(current_database()),
     'tablesBytes', coalesce((select sum(pg_table_size(relid)) from pg_stat_user_tables), 0),
     'indexesBytes', coalesce((select sum(pg_indexes_size(relid)) from pg_stat_user_tables), 0),
     'walBytes', coalesce((select sum(size) from pg_ls_waldir()), 0)),
  'tables', (select coalesce(json_agg(t), '[]'::json) from (
     select relname as name, n_live_tup as "liveRows",
            pg_table_size(relid) as "dataBytes", pg_indexes_size(relid) as "indexBytes",
            seq_scan as "seqScans", coalesce(idx_scan, 0) as "idxScans"
     from pg_stat_user_tables order by pg_table_size(relid) desc limit 50) t),
  'vacuum', json_build_object(
     'totalDeadRows', coalesce((select sum(n_dead_tup) from pg_stat_user_tables), 0),
     'tables', (select coalesce(json_agg(v), '[]'::json) from (
        select s.relname as name, s.n_dead_tup as "deadRows",
               round(100.0 * s.n_dead_tup / greatest(s.n_dead_tup + s.n_live_tup, 1), 1) as "deadPct",
               to_char(greatest(s.last_vacuum, s.last_autovacuum) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "lastVacuum",
               age(c.relfrozenxid) as "xidAge"
        from pg_stat_user_tables s join pg_class c on c.oid = s.relid
        order by s.n_dead_tup desc limit 50) v)),
  'unusedIndexes', (select coalesce(json_agg(u), '[]'::json) from (
     select i.indexrelname as name, i.relname as "table", pg_relation_size(i.indexrelid) as "sizeBytes", i.idx_scan as scans
     from pg_stat_user_indexes i join pg_index x on x.indexrelid = i.indexrelid
     where coalesce(i.idx_scan, 0) = 0 and not x.indisunique and not x.indisprimary
       and not exists (select 1 from pg_constraint con where con.conindid = i.indexrelid)
     order by pg_relation_size(i.indexrelid) desc limit 50) u))`

export type DbInsight = {
  collected: boolean
  sizes: { databaseBytes: number; tablesBytes: number; indexesBytes: number; walBytes: number }
  tables: Array<{ name: string; liveRows: number; dataBytes: number; indexBytes: number; seqScans: number; idxScans: number }>
  vacuum: { totalDeadRows: number; tables: Array<{ name: string; deadRows: number; deadPct: number; lastVacuum?: string; xidAge: number }> }
  unusedIndexes: Array<{ name: string; table: string; sizeBytes: number; scans: number }>
}

export function toDbInsight(rowJson: string): DbInsight {
  const r = JSON.parse(rowJson) as {
    sizes: Record<string, unknown>
    tables: Array<Record<string, unknown>>
    vacuum: { totalDeadRows: unknown; tables: Array<Record<string, unknown>> }
    unusedIndexes: Array<Record<string, unknown>>
  }
  return {
    collected: true, // the local container answered the query, so the sections are real
    sizes: {
      databaseBytes: num(r.sizes.databaseBytes), tablesBytes: num(r.sizes.tablesBytes),
      indexesBytes: num(r.sizes.indexesBytes), walBytes: num(r.sizes.walBytes),
    },
    tables: r.tables.map((t) => ({
      name: String(t.name), liveRows: num(t.liveRows), dataBytes: num(t.dataBytes),
      indexBytes: num(t.indexBytes), seqScans: num(t.seqScans), idxScans: num(t.idxScans),
    })),
    vacuum: {
      totalDeadRows: num(r.vacuum.totalDeadRows),
      tables: r.vacuum.tables.map((v) => ({
        name: String(v.name), deadRows: num(v.deadRows), deadPct: num(v.deadPct),
        ...(v.lastVacuum ? { lastVacuum: String(v.lastVacuum) } : {}), xidAge: num(v.xidAge),
      })),
    },
    unusedIndexes: r.unusedIndexes.map((u) => ({
      name: String(u.name), table: String(u.table), sizeBytes: num(u.sizeBytes), scans: num(u.scans),
    })),
  }
}
