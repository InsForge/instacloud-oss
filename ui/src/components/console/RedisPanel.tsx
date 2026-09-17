// The console's redis Database tab (insta-frontend database/redis-data-tab.tsx, E01): logical-db
// chips, the key list, and the picked key's value, behind the same suspended/wake gate as
// Postgres. Self-host divergences: only the Data view (the daemon has no redis Editor/Stats/
// Configurations), collection values are bounded at the first 200 entries, and the gate copy has
// no billing sentence — nothing is billed here.

import { useCallback, useEffect, useState } from 'react'
import { Button, Skeleton, cn } from '@insforge/ui'
import { KeyRound, Loader2 } from 'lucide-react'
import { api, type RedisKeys, type RedisValue, type Service } from '../../api'
import type { PendingApproval } from '../ApprovalPrompt'
import { dbGateView } from '../../lib/dbWakeGate'

export function RedisPanel({ projectId, branch, service, onApproval }: {
  projectId: string; branch: string; service: Service; onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const [db, setDb] = useState(0)
  const [listing, setListing] = useState<RedisKeys | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [value, setValue] = useState<RedisValue | null>(null)
  const [error, setError] = useState<string>()
  const [sleeping, setSleeping] = useState(false)
  const [waking, setWaking] = useState(false)
  const [awaitingRead, setAwaitingRead] = useState(false)
  const [wakeError, setWakeError] = useState<string>()

  const load = useCallback(async (nextDb: number, cursor?: string) => {
    setError(undefined)
    const r = await api.redisKeys(projectId, service.id, branch, { db: nextDb, ...(cursor ? { cursor } : {}) })
    setAwaitingRead(false)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void load(nextDb, cursor) } })
    if (r.kind === 'error') {
      if (r.status === 503 && /sleeping/i.test(r.error)) return setSleeping(true)
      return setError(r.error)
    }
    setSleeping(false)
    setListing((prev) => cursor && prev ? { ...r.data, keys: [...prev.keys, ...r.data.keys] } : r.data)
  }, [projectId, service.id, branch, onApproval])
  useEffect(() => { void load(db) }, [load, db])

  useEffect(() => {
    if (picked === null) return setValue(null)
    setValue(null)
    void (async () => {
      const r = await api.redisValue(projectId, service.id, picked, branch, db)
      if (r.kind === 'approval') return onApproval({ ...r, retry: () => setPicked(picked) })
      if (r.kind === 'error') return setError(r.error)
      setValue(r.data)
    })()
  }, [picked, projectId, service.id, branch, db, onApproval])

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
  const keyCount = listing?.dbs.find((d) => d.db === db)?.keys ?? listing?.keys.length ?? 0

  return (
    <div className="flex flex-col gap-3">
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
    </div>
  )
}
