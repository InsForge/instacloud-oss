// Which tabs the service detail overlay shows, per service type.
//
// In ui/src/lib rather than beside the modal so it can carry a test: it is pure, and its
// "Volume tab on a managed database" bug was a review Critical. The modal imports react, and a
// test beside a react-importing module cannot load under the root vitest config (see
// test/ui-lib-deps.test.ts).

export type TabId = 'buckets' | 'database' | 'metrics' | 'variables' | 'runtime' | 'volume' | 'settings'

export const TAB_LABELS: Record<TabId, string> = {
  buckets: 'Buckets', database: 'Database', metrics: 'Metrics', variables: 'Variables', runtime: 'Runtime Logs',
  volume: 'Volume', settings: 'Settings',
}

/** The managed database types, as the daemon names them. Exported because the Settings card asks
 *  the same question ("is this a managed database?") and a second copy of the list is how the two
 *  drift. */
export const MANAGED_TYPES = new Set(['redis', 'mysql', 'mongodb'])

export function tabsFor(type: string): TabId[] {
  if (type === 'compute') return ['metrics', 'variables', 'runtime', 'volume', 'settings']
  if (type === 'postgres') return ['database', 'metrics', 'variables', 'runtime', 'settings']
  // No Volume for managed databases, unlike the console: the daemon's volume read and write both
  // refuse every non-compute service, so the tab could only ever show "volumes are only supported
  // for compute services" and an attach could never succeed. A tab that cannot work is worse than
  // an absent one. It comes back if and when the daemon grows managed volumes.
  if (MANAGED_TYPES.has(type)) return ['metrics', 'variables', 'runtime', 'settings']
  // Storage leads with the console's Buckets tab (the bucket + file browser).
  if (type === 'storage') return ['buckets', 'variables', 'settings']
  return ['variables', 'settings']
}
