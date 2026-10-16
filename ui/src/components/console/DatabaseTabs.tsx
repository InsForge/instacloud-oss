// The console's Database sub-tabs (insta-frontend database/data-tab.tsx, sql-editor.tsx,
// extensions-tab.tsx): the Data browser (table rail + first rows), the SQL editor (query tabs,
// Run, result grid) and the Extensions list. All three ride `POST /database/query` and the
// existing extensions routes; the wake gate in DatabaseInsight.tsx fronts them, so a sleeping
// instance never reaches here.
//
// Self-host divergences: the editor is a plain textarea (no CodeMirror — the dashboard adds no
// editor dependency), the Configurations sub-tab has no PgBouncer section (the daemon runs no
// pooler) and never shows the regenerated value (credentials live behind `insta secrets` and the
// Connect dialog), and query tabs live in component state, not the URL.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, ConfirmDialog, Skeleton, Switch, cn } from '@insforge/ui'
import { Plus, Table2 } from 'lucide-react'
import { api, type DbExtensions, type DbQueryResult } from '../../api'
import type { PendingApproval } from '../ApprovalPrompt'
import { cellText, TABLES_SQL, tableRowsSql, DATA_TAB_LIMIT } from '../../lib/sqlBrowse'

/** Every tab takes the shared approval hand-off: a governed action that answers 202 opens the
 *  approval prompt and retries itself after the grant, like every other dashboard action. */
type TabProps = { projectId: string; branch: string; group?: string; onApproval: (p: NonNullable<PendingApproval>) => void }

function Th({ children, className }: { children?: string; className?: string }) {
  return <th className={cn('border-b border-border px-4 py-3 text-left text-[13px] font-normal text-muted-foreground', className)}>{children}</th>
}

/** The rows-or-status result, as the editor and the data browser both print it. */
function ResultGrid({ result, emptyMessage }: { result: DbQueryResult; emptyMessage: string }) {
  if ('status' in result) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{result.status} · {result.ms} ms</p>
  }
  if (result.rowCount === 0) {
    return <p className="px-4 py-6 text-center text-sm text-muted-foreground">{emptyMessage}</p>
  }
  return (
    <div className="max-h-[55vh] overflow-auto overscroll-contain">
      <table className="w-full">
        <thead className="sticky top-0 z-10 bg-card">
          <tr>{result.columns.map((c) => <Th key={c}>{c}</Th>)}</tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i} className="border-b border-border last:border-b-0 hover:bg-alpha-4">
              {row.map((cell, j) => (
                <td key={j} className={cn('max-w-80 truncate px-4 py-2 font-mono text-[13px]', cell === null && 'text-muted-foreground')}
                  title={cellText(cell)}>
                  {cellText(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Data: the table rail on the left, the first rows of the picked table on the right. */
export function DataTab({ projectId, branch, group, onApproval }: TabProps) {
  const [tables, setTables] = useState<Array<{ schema: string; name: string }> | null>(null)
  const [picked, setPicked] = useState<{ schema: string; name: string } | null>(null)
  const [rows, setRows] = useState<DbQueryResult | null>(null)
  const [error, setError] = useState<string>()
  // A slower earlier response must not wear a later selection's name.
  const rowsSeq = useRef(0)

  // State-driven loaders, not a held promise: an approval hands the prompt a retry of the SAME
  // loader (which applies its own result), and a denied or dismissed prompt leaves a message
  // rather than a skeleton waiting on a promise nobody will resolve.
  const loadTables = useCallback(async () => {
    setError(undefined)
    const r = await api.dbQuery(projectId, TABLES_SQL, branch, group)
    if (r.kind === 'approval') {
      setError('Waiting for approval (db.query) — grant it in the prompt and this loads itself.')
      return onApproval({ ...r, retry: () => { void loadTables() } })
    }
    if (r.kind === 'error') return setError(r.error)
    if ('rows' in r.data) {
      const list = r.data.rows.map(([schema, name]) => ({ schema: String(schema), name: String(name) }))
      setTables(list)
      setPicked((prev) => prev ?? list[0] ?? null)
    }
  }, [projectId, branch, group, onApproval])
  useEffect(() => { void loadTables() }, [loadTables])

  const loadRows = useCallback(async (table: { schema: string; name: string }) => {
    setError(undefined)
    setRows(null)
    const seq = ++rowsSeq.current
    const r = await api.dbQuery(projectId, tableRowsSql(table.schema, table.name), branch, group)
    if (seq !== rowsSeq.current) return
    if (r.kind === 'approval') {
      setError('Waiting for approval (db.query) — grant it in the prompt and this loads itself.')
      return onApproval({ ...r, retry: () => { void loadRows(table) } })
    }
    if (r.kind === 'error') return setError(r.error)
    setRows(r.data)
  }, [projectId, branch, group, onApproval])

  useEffect(() => {
    if (!picked) return
    void loadRows(picked)
  }, [picked, loadRows])

  if (error) return <p className="px-1 py-4 text-sm text-destructive">{error}</p>
  if (!tables) return <Skeleton className="h-40 rounded-lg" />
  if (tables.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No tables yet. Create one in the Editor and it appears here.</p>
  }
  return (
    <div className="flex min-h-0 items-start gap-3">
      <div className="w-56 shrink-0 overflow-hidden rounded-lg border border-border bg-card">
        <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">Tables</div>
        <div className="max-h-[55vh] overflow-y-auto p-1">
          {tables.map((t) => {
            const active = picked?.schema === t.schema && picked?.name === t.name
            return (
              <button key={`${t.schema}.${t.name}`} type="button" onClick={() => setPicked(t)}
                className={cn('flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[13px] transition-colors',
                  active ? 'bg-alpha-8' : 'hover:bg-alpha-4')}>
                <Table2 className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate" title={`${t.schema}.${t.name}`}>
                  {t.schema === 'public' ? t.name : `${t.schema}.${t.name}`}
                </span>
              </button>
            )
          })}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-card">
        {rows ? (
          <>
            <ResultGrid result={rows} emptyMessage="This table is empty." />
            {'rowCount' in rows && rows.rowCount >= DATA_TAB_LIMIT && (
              <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">First {DATA_TAB_LIMIT} rows. Use the Editor for more.</p>
            )}
          </>
        ) : (
          <Skeleton className="m-4 h-32 rounded-lg" />
        )}
      </div>
    </div>
  )
}

type Query = { id: number; title: string; sql: string; result?: DbQueryResult; error?: string; running?: boolean }

/** Editor: query tabs + Add Query over a statement box, Run, and the result pane. */
export function EditorTab({ projectId, branch, group, onApproval }: TabProps) {
  const [queries, setQueries] = useState<Query[]>([{ id: 1, title: 'Query 1', sql: '' }])
  const [active, setActive] = useState(1)
  const q = queries.find((x) => x.id === active) ?? queries[0]
  const patch = (id: number, next: Partial<Query>) =>
    setQueries((prev) => prev.map((x) => (x.id === id ? { ...x, ...next } : x)))
  // A result binds to the SQL that PRODUCED it: the textarea stays editable while a request
  // runs, so a slow answer for statement A must not land under an edited statement B (nor may
  // an approval retry, which captures the old statement). The tab only accepts a response
  // while its text still equals the text that was sent.
  const settle = (id: number, sentSql: string, next: Partial<Query>) =>
    setQueries((prev) => prev.map((x) => x.id !== id ? x : x.sql === sentSql ? { ...x, ...next } : { ...x, running: false }))

  const run = async (query: Query) => {
    if (!query.sql.trim() || query.running) return
    patch(query.id, { running: true, error: undefined })
    const r = await api.dbQuery(projectId, query.sql, branch, group)
    if (r.kind === 'error') return settle(query.id, query.sql, { running: false, result: undefined, error: r.error })
    if (r.kind === 'approval') {
      patch(query.id, { running: false })
      return onApproval({ ...r, retry: () => { void run(query) } })
    }
    settle(query.id, query.sql, { running: false, result: r.data, error: undefined })
  }

  const addQuery = () => {
    const id = Math.max(...queries.map((x) => x.id)) + 1
    setQueries((prev) => [...prev, { id, title: `Query ${id}`, sql: '' }])
    setActive(id)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1">
        {queries.map((x) => (
          <button key={x.id} type="button" onClick={() => setActive(x.id)}
            className={cn('cursor-pointer rounded-md px-2.5 py-1 text-sm transition-colors',
              x.id === q.id ? 'bg-alpha-8 font-medium' : 'text-muted-foreground hover:bg-alpha-4')}>
            {x.title}
          </button>
        ))}
        <Button variant="ghost" size="sm" className="gap-1 text-muted-foreground" onClick={addQuery}>
          <Plus className="size-3.5" />
          Add Query
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <textarea value={q.sql} onChange={(e) => patch(q.id, { sql: e.target.value })}
          placeholder="-- write a SQL statement" rows={6} spellCheck={false}
          aria-label={`${q.title} statement`}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void run(q) } }}
          className="w-full resize-y bg-transparent px-4 py-3 font-mono text-[13px] outline-none placeholder:text-muted-foreground" />
        <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
          <p className="text-xs text-muted-foreground">⌘⏎ runs. Statements apply immediately — there is no staged Deploy here.</p>
          <Button variant="primary" size="sm" disabled={!q.sql.trim() || q.running} onClick={() => { void run(q) }}>
            {q.running ? 'Running…' : 'Run'}
          </Button>
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {q.error ? (
          <p className="px-4 py-6 text-sm text-destructive">Query failed. {q.error}</p>
        ) : q.result ? (
          <ResultGrid result={q.result} emptyMessage="The statement returned no rows." />
        ) : (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">Click Run to execute your query</p>
        )}
      </div>
    </div>
  )
}

/** Configurations: the console's Username / Password rows (D02). The regenerate re-mints
 *  DATABASE_URL on the daemon; running containers keep the old env until their next deploy. */
export function ConfigurationsTab({ projectId, branch, group, onApproval }: TabProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string>()

  const regenerate = async () => {
    setBusy(true); setError(undefined); setDone(false)
    const r = await api.dbRegeneratePassword(projectId, branch, group)
    setBusy(false); setConfirmOpen(false)
    if (r.kind === 'error') return setError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void regenerate() } })
    setDone(true)
  }

  const row = 'flex items-start justify-between gap-6 border-b border-border px-4 py-4 last:border-b-0'
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className={row}>
          <div>
            <p className="text-sm font-medium">Username</p>
            <p className="mt-1 text-sm text-muted-foreground">The postgres role your connection string uses.</p>
          </div>
          <span className="font-mono text-[13px]">postgres</span>
        </div>
        <div className={row}>
          <div>
            <p className="text-sm font-medium">Password</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Regenerate Password &mdash; breaks existing connections until they use the new password. Deployed
              containers keep the old value until their next deploy.
            </p>
            {done && (
              <p className="mt-2 text-sm text-success">
                Password regenerated. Read the new connection string in the Connect dialog or with{' '}
                <span className="font-mono">insta secrets --print</span>.
              </p>
            )}
            {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[13px] tracking-widest text-muted-foreground select-none">••••••••••••••••</span>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmOpen(true)}>Regenerate</Button>
          </div>
        </div>
      </div>
      {confirmOpen && (
        <ConfirmDialog open onOpenChange={setConfirmOpen} title="Regenerate Password" confirmText="Regenerate"
          destructive isLoading={busy}
          description="Breaks existing connections until they use the new password. Deployed containers keep the old value until their next deploy."
          onConfirm={() => { void regenerate() }} />
      )}
    </div>
  )
}

/** Extensions: what the instance offers, with an enable/disable switch per row. */
export function ExtensionsTab({ projectId, branch, group, onApproval }: TabProps) {
  const [list, setList] = useState<DbExtensions | null>(null)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()

  const load = useCallback(async () => {
    try { setList(await api.dbExtensions(projectId, branch, group)) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [projectId, branch, group])
  useEffect(() => { void load() }, [load])

  const toggle = async (name: string, enable: boolean) => {
    setBusy(name); setError(undefined)
    const r = await api.dbPatchExtensions(projectId, enable ? { enable: [name] } : { disable: [name] }, branch, group)
    setBusy(undefined)
    if (r.kind === 'error') return setError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void toggle(name, enable) } })
    setList(r.data)
  }

  if (error && !list) return <p className="px-1 py-4 text-sm text-destructive">{error}</p>
  if (!list) return <Skeleton className="h-40 rounded-lg" />
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <table className="w-full table-fixed">
          <thead>
            <tr><Th>Extension</Th><Th className="w-28 text-right">Enabled</Th></tr>
          </thead>
          <tbody>
            {list.available.map((ext) => {
              const on = list.enabled.includes(ext.name)
              return (
                <tr key={ext.name} className="border-b border-border last:border-b-0 hover:bg-alpha-4">
                  <td className="truncate px-4 py-2 font-mono text-[13px]">
                    {ext.name}
                    {/* The daemon marks what its own observability depends on; the switch is off-limits there. */}
                    {ext.required && <span className="ml-2 rounded-md bg-alpha-8 px-1.5 py-0.5 font-sans text-xs text-muted-foreground">required</span>}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end">
                      <Switch checked={on} disabled={busy === ext.name || ext.required === true}
                        aria-label={`Enable ${ext.name}`}
                        onCheckedChange={(v) => { void toggle(ext.name, v === true) }} />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
