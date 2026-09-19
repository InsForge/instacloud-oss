import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button, EmptyState } from '@insforge/ui'
import { Database, Loader2 } from 'lucide-react'
import { api } from '../api'
import { usePoll } from '../hooks'
import { dbGateView, dbPanelKey } from '../lib/dbWakeGate'
import { ApprovalPrompt, type PendingApproval } from '../components/ApprovalPrompt'
import { ConsolePage } from '../components/console/ConsolePage'
import { TopTabs } from '../components/console/Tabs'
import { ConfigurationsTab, DataTab, EditorTab, ExtensionsTab } from '../components/console/DatabaseTabs'

/** The console's Database sub-tabs (D02), in its order: Data, Editor, Stats, Configurations,
 *  Extension. */
const DB_TABS = [
  { id: 'data', label: 'Data' }, { id: 'editor', label: 'Editor' }, { id: 'stats', label: 'Stats' },
  { id: 'configurations', label: 'Configurations' }, { id: 'extension', label: 'Extension' },
] as const
type DbTabId = (typeof DB_TABS)[number]['id']

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`
  return `${n.toFixed(0)} B`
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="mt-2 text-[28px] font-bold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Th({ children, className }: { children?: string; className?: string }) {
  return <th className={`px-4 py-3 text-left text-[13px] font-normal text-muted-foreground ${className ?? ''}`}>{children}</th>
}

/** A read that answered 503 `database is sleeping`: the daemon never wakes a database to answer a
 *  dashboard poll (decision 48), so the panel says so instead of retrying in a loop. */
function isSleeping(e: Error | undefined): boolean {
  if (!e) return false
  const status = (e as Error & { status?: number }).status
  return status === 503 && /sleeping/i.test(e.message)
}

/** Point-in-time insight for one Postgres service: the same SQL signals the cloud serves
 *  (pg_stat_activity / pg_stat_database / pg_stat_statements). The page and a Postgres service's
 *  Database tab both render it.
 *
 *  Asleep, it is the console's instance gate (insta-frontend database/instance-gate.tsx): "Instance is suspended"
 *  with Wake and browse, then "Connecting to the database…" from the click until the first read after the wake
 *  answers, which then decides (lib/dbWakeGate.ts). Self-host divergence: the console
 *  wakes by letting its queries through; the daemon's reads never wake a database, so the button asks for the wake
 *  explicitly (`POST …/services/:sid/wake`) and the reads resume once it is up. No billing sentence: nothing is
 *  billed here. */
export function DatabasePanel({ projectId, branch, group, serviceId, footer, onApproval }: {
  projectId: string; branch: string; group?: string; serviceId?: string; footer?: React.ReactNode
  onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const metricsPoll = usePoll(() => api.dbMetrics(projectId, branch, group), [projectId, branch, group], { intervalMs: 10000 })
  const sleeping = isSleeping(metricsPoll.error)
  const { data: metrics, error, reload } = metricsPoll
  const { data: activity } = usePoll(() => api.dbActivity(projectId, branch, group), [projectId, branch, group], { intervalMs: 10000, enabled: !sleeping })
  const { data: stats } = usePoll(() => api.dbQueryStats(projectId, branch, group), [projectId, branch, group], { intervalMs: 15000, enabled: !sleeping })
  const [waking, setWaking] = useState(false)
  const [awaitingRead, setAwaitingRead] = useState(false)
  const [wakeError, setWakeError] = useState<string>()
  const [sub, setSub] = useState<DbTabId>('data')
  // The hold ends when the metrics poll delivers its next answer, data or error; that answer decides what shows.
  useEffect(() => { setAwaitingRead(false) }, [metricsPoll.data, metricsPoll.error])

  const wake = async () => {
    if (!serviceId) return
    setWaking(true); setWakeError(undefined)
    const r = await api.wakeService(projectId, serviceId, branch)
    if (r.kind === 'error') { setWaking(false); return setWakeError(r.error) }
    if (r.kind === 'approval') { setWaking(false); return setWakeError('Waking this database needs an approval first.') }
    setAwaitingRead(true)
    setWaking(false)
    reload()
  }

  const view = dbGateView({ sleeping, waking, awaitingRead, wakeError })
  if (view !== 'content') {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-border bg-card">
          {view === 'connecting' ? (
            <div className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Connecting to the database…
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <p className="text-sm font-medium">Instance is suspended</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Browsing data wakes the database. It suspends again on its own after it goes idle.
              </p>
              {serviceId
                ? <Button onClick={() => { void wake() }}>Wake and browse</Button>
                : <Button variant="secondary" onClick={reload}>Check again</Button>}
              {wakeError && <p className="text-sm text-destructive">{wakeError}</p>}
            </div>
          )}
        </div>
        {footer}
      </div>
    )
  }

  // Until the FIRST metrics answer arrives, sleeping is simply unknown — mounting the Data tab
  // then would fire queries at an instance the gate is about to say is suspended.
  if (!metrics && !error) {
    return (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-lg bg-alpha-8" />)}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <TopTabs tabs={DB_TABS} value={sub} onChange={setSub} label="Database views" />
      {sub === 'data' && <DataTab projectId={projectId} branch={branch} group={group} onApproval={onApproval} />}
      {sub === 'editor' && <EditorTab projectId={projectId} branch={branch} group={group} onApproval={onApproval} />}
      {sub === 'configurations' && <ConfigurationsTab projectId={projectId} branch={branch} group={group} onApproval={onApproval} />}
      {sub === 'extension' && <ExtensionsTab projectId={projectId} branch={branch} group={group} onApproval={onApproval} />}
      {sub === 'stats' && <StatsContent metrics={metrics} error={error} activity={activity} stats={stats} />}
    </div>
  )
}

/** The point-in-time stats blocks (the panel's original body), now the Stats sub-tab. */
function StatsContent({ metrics, error, activity, stats }: {
  metrics: Awaited<ReturnType<typeof api.dbMetrics>> | undefined
  error: Error | undefined
  activity: Awaited<ReturnType<typeof api.dbActivity>> | undefined
  stats: Awaited<ReturnType<typeof api.dbQueryStats>> | undefined
}) {
  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-destructive">{error.message}</div>
      )}
      {!metrics && !error && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-lg bg-alpha-8" />)}
        </div>
      )}
      {metrics && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Stat label="Connections" value={`${metrics.connections.total}`}
            hint={`${metrics.connections.active} active · ${metrics.connections.idle} idle · max ${metrics.connections.max}`} />
          <Stat label="Database size" value={fmtBytes(metrics.dbSizeBytes)} />
          <Stat label="Cache hit" value={`${(metrics.cacheHitRatio * 100).toFixed(1)}%`} hint={`${metrics.deadlocks} deadlocks`} />
          <Stat label="Tuple churn" value={`${metrics.tuples.inserted + metrics.tuples.updated + metrics.tuples.deleted}`}
            hint={`${metrics.tuples.inserted} ins · ${metrics.tuples.updated} upd · ${metrics.tuples.deleted} del`} />
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3 text-sm font-medium">Running queries</div>
        <table className="w-full table-fixed">
          <thead>
            <tr className="border-b border-border">
              <Th className="w-16">PID</Th>
              <Th className="w-24">State</Th>
              <Th className="w-28">Duration</Th>
              <Th>Query</Th>
            </tr>
          </thead>
          <tbody>
            {!activity?.length ? (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-sm text-muted-foreground">Nothing running right now.</td></tr>
            ) : activity.map((r) => (
              <tr key={r.pid} className="border-b border-border last:border-b-0">
                <td className="px-4 py-2.5 text-[13px] tabular-nums">{r.pid}</td>
                <td className="px-4 py-2.5 text-[13px]">{r.state ?? '—'}</td>
                <td className="px-4 py-2.5 text-[13px] text-muted-foreground tabular-nums">
                  {r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}
                </td>
                <td className="truncate px-4 py-2.5 font-mono text-[13px]" title={r.query}>{r.query ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3 text-sm font-medium">Top statements</div>
        <table className="w-full table-fixed">
          <thead>
            <tr className="border-b border-border">
              <Th>Query</Th>
              <Th className="w-20">Calls</Th>
              <Th className="w-24">Mean</Th>
              <Th className="w-24">Total</Th>
            </tr>
          </thead>
          <tbody>
            {stats && !stats.extensionReady ? (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-sm text-muted-foreground">
                Statement stats need pg_stat_statements — available on databases provisioned after the
                observability update; recreate the branch to enable it.
              </td></tr>
            ) : !stats?.stats.length ? (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-sm text-muted-foreground">No statements recorded yet.</td></tr>
            ) : stats.stats.map((s) => (
              <tr key={s.queryId} className="border-b border-border last:border-b-0">
                <td className="truncate px-4 py-2.5 font-mono text-[13px]" title={s.query}>{s.query}</td>
                <td className="px-4 py-2.5 text-[13px] tabular-nums">{s.calls}</td>
                <td className="px-4 py-2.5 text-[13px] text-muted-foreground tabular-nums">{s.meanMs.toFixed(1)} ms</td>
                <td className="px-4 py-2.5 text-[13px] text-muted-foreground tabular-nums">{s.totalMs.toFixed(0)} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Reads run against this branch&apos;s database on each refresh and never wake it: a sleeping
        Postgres answers with its sleeping state instead.
      </p>
    </div>
  )
}

/** The environment's (first) Postgres, as a page. */
export function DatabaseInsight() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  const { data: services, error } = usePoll(() => api.services(projectId, branch), [projectId, branch], 15000)
  const pg = useMemo(() => (services ?? []).find((s) => s.type === 'postgres'), [services])
  const [approval, setApproval] = useState<PendingApproval>(null)

  return (
    <ConsolePage title="Database">
      {/* Rendering null while the service list is in flight, or when it failed, left the page as a
          bare title with no sign that anything was happening. */}
      {!services && !error ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-lg bg-alpha-8" />)}
        </div>
      ) : error ? (
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-destructive">{error.message}</div>
      ) : services && !pg ? (
        <EmptyState icon={Database} title="No Postgres in this branch"
          description="Add a postgres service on the Service page and this page fills in." />
      ) : pg ? (
        // Keyed by the database's full identity: this page stays mounted when the project or branch switches.
        <DatabasePanel key={dbPanelKey(projectId, branch, pg.id)} projectId={projectId} branch={branch} group={pg.name} serviceId={pg.id}
          onApproval={setApproval}
          footer={
            <div className="flex justify-center">
              <Link to={`/p/${projectId}/${branch}/services?service=${encodeURIComponent(pg.id)}&tab=settings`}>
                <Button variant="secondary">Service settings</Button>
              </Link>
            </div>
          } />
      ) : null}
      <ApprovalPrompt projectId={projectId} pending={approval} onClose={() => setApproval(null)} />
    </ConsolePage>
  )
}
