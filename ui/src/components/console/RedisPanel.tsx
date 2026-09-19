// The console's redis Database tab (insta-frontend database/redis-data-tab.tsx, E01): Data
// (logical-db chips, the key list, the picked key's value) and Stats (the server's INFO counters),
// behind the same suspended/wake gate as Postgres. Self-host divergences: no Editor or
// Configurations sub-tab (an arbitrary-command editor is a different security posture than reads,
// and the credentials live behind `insta secrets`), collection values are bounded at the first 200
// entries, and the gate copy has no billing sentence — nothing is billed here.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Skeleton, cn } from '@insforge/ui'
import { KeyRound, Loader2 } from 'lucide-react'
import { api, type ApiResult, type RedisKeys, type RedisStats, type RedisValue, type Service } from '../../api'
import type { PendingApproval } from '../ApprovalPrompt'
import { dbGateView } from '../../lib/dbWakeGate'
import { TopTabs } from './Tabs'

/** A read that answered 503 sleeping: the instance suspended, so the panel returns to the gate. */
function sleptAway<T>(r: ApiResult<T>): boolean {
  return r.kind === 'error' && r.status === 503 && /sleeping/i.test(r.error)
}

const REDIS_TABS = [{ id: 'data', label: 'Data' }, { id: 'stats', label: 'Stats' }] as const
type RedisTabId = (typeof REDIS_TABS)[number]['id']

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`
  return `${n.toFixed(0)} B`
}

function fmtUptime(sec: number): string {
  if (sec >= 86_400) return `${Math.floor(sec / 86_400)}d ${Math.floor((sec % 86_400) / 3_600)}h`
  if (sec >= 3_600) return `${Math.floor(sec / 3_600)}h ${Math.floor((sec % 3_600) / 60)}m`
  return `${Math.floor(sec / 60)}m`
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="mt-2 text-[28px] font-bold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** The Stats sub-tab: INFO counters as cards, like the postgres Stats blocks. */
function RedisStatsView({ projectId, branch, service, onApproval, onSleeping }: {
  projectId: string; branch: string; service: Service
  onApproval: (p: NonNullable<PendingApproval>) => void; onSleeping: () => void
}) {
  const [stats, setStats] = useState<RedisStats | null>(null)
  const [error, setError] = useState<string>()
  const load = useCallback(async () => {
    setError(undefined)
    const r = await api.redisStats(projectId, service.id, branch)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void load() } })
    if (sleptAway(r)) return onSleeping()
    if (r.kind === 'error') return setError(r.error)
    setStats(r.data)
  }, [projectId, service.id, branch, onApproval, onSleeping])
  useEffect(() => { void load() }, [load])

  if (error) return <p className="px-1 py-4 text-sm text-destructive">{error}</p>
  if (!stats) return <Skeleton className="h-32 rounded-lg" />
  const lookups = stats.keyspaceHits + stats.keyspaceMisses
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Memory" value={fmtBytes(stats.usedMemoryBytes)}
          hint={stats.maxMemoryBytes > 0 ? `of ${fmtBytes(stats.maxMemoryBytes)}` : 'no maxmemory limit'} />
        <StatCard label="Clients" value={String(stats.connectedClients)} hint={`${stats.opsPerSec} ops/s now`} />
        <StatCard label="Cache hit" value={lookups ? `${((stats.keyspaceHits / lookups) * 100).toFixed(1)}%` : '—'}
          hint={`${stats.keyspaceHits} hits · ${stats.keyspaceMisses} misses`} />
        <StatCard label="Commands" value={String(stats.totalCommands)}
          hint={`${stats.expiredKeys} expired · ${stats.evictedKeys} evicted keys`} />
      </div>
      <p className="text-xs text-muted-foreground">valkey {stats.version} · up {fmtUptime(stats.uptimeSec)}</p>
    </div>
  )
}

export function RedisPanel({ projectId, branch, service, onApproval }: {
  projectId: string; branch: string; service: Service; onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const [sub, setSub] = useState<RedisTabId>('data')
  const [db, setDb] = useState(0)
  const [listing, setListing] = useState<RedisKeys | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [value, setValue] = useState<RedisValue | null>(null)
  const [error, setError] = useState<string>()
  const [sleeping, setSleeping] = useState(false)
  const [waking, setWaking] = useState(false)
  const [awaitingRead, setAwaitingRead] = useState(false)
  const [wakeError, setWakeError] = useState<string>()

  // Out-of-order guards: each request takes a sequence number and only the LATEST one may write
  // state, so a slow db0 listing can never wear db1's name, nor key A's value key B's pane.
  const listSeq = useRef(0)
  const valueSeq = useRef(0)
  // Stable, or every parent render (the approval prompt opening included) re-fires the stats
  // effect and mints a fresh gated request — an approval loop instead of one retryable prompt.
  const onStatsSleeping = useCallback(() => setSleeping(true), [])

  const load = useCallback(async (nextDb: number, cursor?: string) => {
    setError(undefined)
    const seq = ++listSeq.current
    const r = await api.redisKeys(projectId, service.id, branch, { db: nextDb, ...(cursor ? { cursor } : {}) })
    if (seq !== listSeq.current) return
    setAwaitingRead(false)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void load(nextDb, cursor) } })
    if (sleptAway(r)) return setSleeping(true)
    if (r.kind === 'error') return setError(r.error)
    setSleeping(false)
    setListing((prev) => cursor && prev ? { ...r.data, keys: [...prev.keys, ...r.data.keys] } : r.data)
  }, [projectId, service.id, branch, onApproval])
  useEffect(() => { void load(db) }, [load, db])

  // A named loader, so an approval grant retries THIS read (retrying via setPicked(picked) was a
  // React no-op) and a failed key's error clears when the next key is picked.
  const loadValue = useCallback(async (key: string) => {
    setError(undefined)
    setValue(null)
    const seq = ++valueSeq.current
    const r = await api.redisValue(projectId, service.id, key, branch, db)
    if (seq !== valueSeq.current) return
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void loadValue(key) } })
    if (sleptAway(r)) return setSleeping(true)
    if (r.kind === 'error') return setError(r.error)
    setValue(r.data)
  }, [projectId, service.id, branch, db, onApproval])

  useEffect(() => {
    if (picked === null) return setValue(null)
    void loadValue(picked)
  }, [picked, loadValue])

  const wake = async () => {
    setWaking(true); setWakeError(undefined)
    const r = await api.wakeService(projectId, service.id, branch)
    if (r.kind === 'error') { setWaking(false); return setWakeError(r.error) }
    if (r.kind === 'approval') { setWaking(false); return setWakeError('Waking this database needs an approval first.') }
    setAwaitingRead(true)
    setWaking(false)
    void load(db)
  }

  const view = dbGateView({ sleeping, waking, awaitingRead, wakeError })
  if (view !== 'content') {
    return (
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
            <Button onClick={() => { void wake() }}>Wake and browse</Button>
            {wakeError && <p className="text-sm text-destructive">{wakeError}</p>}
          </div>
        )}
      </div>
    )
  }

  // The chips: every logical db that holds keys, plus the selected one (db0 shows even when empty).
  const chips = [...new Set([0, ...(listing?.dbs.map((d) => d.db) ?? []), db])].sort((a, b) => a - b)
  // What is actually LOADED into the list (the daemon's per-db total can be larger than one page).
  const keyCount = listing?.keys.length ?? 0

  return (
    <div className="flex flex-col gap-3">
      <TopTabs tabs={REDIS_TABS} value={sub} onChange={setSub} label="Redis views" />
      {sub === 'stats' && (
        <RedisStatsView projectId={projectId} branch={branch} service={service} onApproval={onApproval}
          onSleeping={onStatsSleeping} />
      )}
      {sub === 'data' && <>
      <div className="flex items-center gap-2">
        {chips.map((d) => (
          <button key={d} type="button" onClick={() => { setDb(d); setPicked(null); setListing(null) }}
            className={cn('cursor-pointer rounded-md px-2.5 py-1 font-mono text-[13px] transition-colors',
              d === db ? 'bg-alpha-8 font-medium' : 'text-muted-foreground hover:bg-alpha-4')}>
            db{d}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {listing ? `${keyCount} key${keyCount === 1 ? '' : 's'} loaded` : ''}
        </span>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!listing ? (
        <Skeleton className="h-48 rounded-lg" />
      ) : (
        <div className="flex min-h-0 items-start gap-3">
          <div className="w-64 shrink-0 overflow-hidden rounded-lg border border-border bg-card">
            <div className="max-h-[55vh] overflow-y-auto p-1">
              {listing.keys.length === 0 ? (
                <p className="px-3 py-8 text-center text-sm text-muted-foreground">No keys in db{db}.</p>
              ) : listing.keys.map((key) => (
                <button key={key} type="button" onClick={() => setPicked(key)}
                  className={cn('flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[13px] transition-colors',
                    picked === key ? 'bg-alpha-8' : 'hover:bg-alpha-4')}>
                  <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate" title={key}>{key}</span>
                </button>
              ))}
              {listing.cursor && (
                <button type="button" className="w-full cursor-pointer px-2 py-1.5 text-center text-xs text-muted-foreground hover:bg-alpha-4"
                  onClick={() => { void load(db, listing.cursor) }}>
                  Load more
                </button>
              )}
            </div>
          </div>
          <div className="min-w-0 flex-1 rounded-lg border border-border bg-card">
            {picked === null ? (
              <p className="px-4 py-16 text-center text-sm text-muted-foreground">Select a key to view its value.</p>
            ) : !value ? (
              <Skeleton className="m-4 h-24 rounded-lg" />
            ) : (
              <div className="flex flex-col gap-2 p-4">
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="rounded-md bg-alpha-8 px-1.5 py-0.5 font-medium">{value.type}</span>
                  <span>{value.ttl < 0 ? 'no expiry' : `TTL ${value.ttl}s`}</span>
                </div>
                <pre className="max-h-[45vh] overflow-auto font-mono text-[13px] break-words whitespace-pre-wrap">
                  {typeof value.value === 'string' ? value.value : JSON.stringify(value.value, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
      </>}
    </div>
  )
}
