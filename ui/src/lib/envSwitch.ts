// The environment switcher's two decisions, pure so the root vitest covers them (the dashboard has
// no component-test setup). Mirrors the console's env-switcher.tsx: switching keeps the page you
// are on, and the badge says Prod / Preview, or Failed for an environment that is not usable.

export type EnvBadge = { label: 'Prod' | 'Preview' | 'Failed'; className: string }

/** The page to land on in the other environment. A service id is branch-scoped (decision 49), so
 *  a service's detail lands on the other environment's list rather than on an id that means
 *  nothing there. */
export function subpageForSwitch(pathname: string): string {
  const sub = pathname.match(/^\/p\/[^/]+\/[^/]+\/(.+)$/)?.[1]
  if (!sub) return 'services'
  return sub.startsWith('services/') ? 'services' : sub
}

/** Squared on purpose, like the console's EnvStatusBadge. A branch whose teardown failed is kept
 *  so it can be retried; it is not somewhere to work, so it badges as Failed, not by its role. */
export function envBadge(env: { is_default: boolean; status: string }): EnvBadge {
  if (env.status === 'cleanup-failed' || env.status === 'error') return { label: 'Failed', className: 'bg-destructive text-inverse' }
  return env.is_default
    ? { label: 'Prod', className: 'bg-warning text-inverse' }
    : { label: 'Preview', className: 'bg-success text-inverse' }
}
