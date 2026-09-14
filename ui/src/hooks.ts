import { useCallback, useEffect, useMemo, useState } from 'react'
import { startPoll } from './lib/pollLoop'

export type PollOptions = {
  /** Default 5 s (the daemon is local or one hop away). */
  intervalMs?: number
  /** false skips the fetch and the timer but keeps the last data (plan 07 K: a sleeping database). */
  enabled?: boolean
}

/** Poll a fetcher on an interval. The third argument is either the interval (legacy) or an
 *  options bag. Every fetch is a state or docker read on the daemon; none passes through a
 *  router lane, so polling never keeps a service awake (plan 07 M). */
export function usePoll<T>(fn: () => Promise<T>, deps: unknown[], opts: number | PollOptions = 5000): {
  data: T | undefined; error: Error | undefined; reload: () => void; loading: boolean
} {
  const { intervalMs = 5000, enabled = true } = typeof opts === 'number' ? { intervalMs: opts } : opts
  const [data, setData] = useState<T>()
  const [error, setError] = useState<Error>()
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!enabled) return
    // Each effect run owns its loop, and cleanup stops THAT loop (lib/pollLoop.ts). A shared "alive"
    // ref was set back to true by the next run before the old request resolved, so the old request
    // wrote stale data and kept polling forever — one more loop per dependency change.
    return startPoll(fn, {
      onData: (d) => { setData(d); setError(undefined) },
      onError: (e) => { setError(e as Error) },
      onSettled: () => { setLoading(false) },
    }, intervalMs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, intervalMs, enabled])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, reload, loading }
}

/** The router's hold bound: a wake that has not settled by then is no longer "waking". */
export const WAKE_TTL_MS = 60_000

export type HealthLike = { serviceId: string; status: string }

/** Which services the user (or a deploy) just woke, so the row can say "Waking" until the next
 *  runtime-health read reports healthy or crashed, or 60 s pass. Keyed by the row id from the
 *  branch's own services listing (decision 49: ids are opaque and branch-scoped). */
export function useWaking(): {
  isWaking: (id: string) => boolean
  anyWaking: boolean
  wake: (id: string) => void
  reconcile: (health: HealthLike[] | undefined, lookup: (rows: HealthLike[] | undefined, id: string) => HealthLike | undefined) => void
} {
  const [started, setStarted] = useState<Record<string, number>>({})
  const anyWaking = useMemo(() => Object.keys(started).length > 0, [started])

  const wake = useCallback((id: string) => setStarted((m) => ({ ...m, [id]: Date.now() })), [])
  const isWaking = useCallback((id: string) => started[id] !== undefined, [started])

  const reconcile = useCallback((health: HealthLike[] | undefined, lookup: (rows: HealthLike[] | undefined, id: string) => HealthLike | undefined) => {
    setStarted((m) => {
      const now = Date.now()
      let changed = false
      const next: Record<string, number> = {}
      for (const [id, at] of Object.entries(m)) {
        const h = lookup(health, id)
        const settled = h?.status === 'healthy' || h?.status === 'crashed'
        if (settled || now - at > WAKE_TTL_MS) { changed = true; continue }
        next[id] = at
      }
      return changed ? next : m
    })
  }, [])

  // Belt for the TTL when health stops arriving (page hidden, daemon unreachable).
  useEffect(() => {
    if (!anyWaking) return
    const t = setInterval(() => reconcile(undefined, () => undefined), 5000)
    return () => clearInterval(t)
  }, [anyWaking, reconcile])

  return { isWaking, anyWaking, wake, reconcile }
}
