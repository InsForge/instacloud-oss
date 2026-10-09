import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { api, setOnUnauthorized, type PublicUser } from '../api'
import { readBoot, type Boot, type RunMode } from '../lib/mode'

export type AuthState = {
  mode: RunMode
  boot: Boot
  /** The signed-in admin in server mode; null in local mode (no identity there). */
  user: PublicUser | null
  /** Server mode before the admin exists; flips to false once a session is seen. */
  setupRequired: boolean
  /** Re-read the session (after sign-up or sign-in). */
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthGate')
  return v
}

type SessionState = 'loading' | { user: PublicUser } | null

/** Local mode: no gate, today's flow. Server mode (plan 07 A): one `GET /api/auth/get-session`;
 *  no session sends the visit to /setup (first run) or /login?next=...; a 401 from any later call
 *  drops the session so the same redirect fires. */
export function AuthGate({ children }: { children: ReactNode }) {
  const boot = useMemo(() => readBoot(), [])
  if (boot.mode === 'local') return <LocalGate boot={boot}>{children}</LocalGate>
  return <ServerGate boot={boot}>{children}</ServerGate>
}

function LocalGate({ boot, children }: { boot: Boot; children: ReactNode }) {
  const value = useMemo<AuthState>(() => ({
    mode: 'local', boot, user: null, setupRequired: false,
    refresh: async () => {}, signOut: async () => {},
  }), [boot])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

function ServerGate({ boot, children }: { boot: Boot; children: ReactNode }) {
  const [session, setSession] = useState<SessionState>('loading')
  const [setupRequired, setSetupRequired] = useState(boot.setupRequired)
  const loc = useLocation()

  const refresh = useCallback(async () => {
    try {
      const s = await api.getSession()
      if (s?.user) {
        setSession({ user: { id: s.user.id, email: s.user.email, name: s.user.name, emailVerified: s.user.emailVerified } })
        setSetupRequired(false)
      } else {
        setSession(null)
      }
    } catch {
      setSession(null)
    }
  }, [])

  const signOut = useCallback(async () => {
    await api.signOut()
    setSession(null)
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    setOnUnauthorized(() => setSession(null))
    return () => setOnUnauthorized(null)
  }, [])

  const value = useMemo<AuthState>(() => ({
    mode: 'server', boot, user: session === 'loading' || session === null ? null : session.user,
    setupRequired, refresh, signOut,
  }), [boot, session, setupRequired, refresh, signOut])

  if (session === 'loading') return null
  const onAuthPage = loc.pathname === '/login' || loc.pathname === '/setup'
  if (session === null) {
    if (setupRequired && loc.pathname !== '/setup') return <Navigate to="/setup" replace />
    if (!onAuthPage) {
      const next = encodeURIComponent(loc.pathname + loc.search)
      return <Navigate to={`/login?next=${next}`} replace />
    }
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** `?next=` may only point back into this SPA: absolute paths, never `//host` or a scheme. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/'
  return next
}
