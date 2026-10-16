// The storage half of a local preference, with NO react import.
//
// Split from localPref.ts deliberately. The root vitest config runs `ui/src/lib/*.test.ts`, but
// only the root `npm ci` runs in CI, so `react` does not resolve from a module under ui/. A test
// beside a file that imports react therefore fails to LOAD, which sets a non-zero exit code while
// the summary still reads "N passed" with zero failing tests — green-looking, red CI. Keeping the
// pure half here lets it be tested under the existing config; the hooks stay in localPref.ts.

const listeners = new Map<string, Set<() => void>>()

// What a write held when localStorage refused it (a private window, blocked site data, a full
// quota). Without this the catch below swallowed the write and the snapshot re-read `null`, so the
// theme and sidebar toggles did nothing at all, rather than the "works until reload" this promised.
// Only written on failure, so a working localStorage is still the single source.
const fallback = new Map<string, string | null>()

export function subscribers(key: string): Set<() => void> {
  let set = listeners.get(key)
  if (!set) listeners.set(key, (set = new Set()))
  return set
}

export function emit(key: string): void {
  listeners.get(key)?.forEach((listener) => { listener() })
}

export function readLocal(key: string): string | null {
  // The fallback wins whenever it holds this key, not only when the read throws. A FULL store is
  // the case that separates them: `setItem` throws on quota while `getItem` keeps working, so
  // consulting storage first returned the value the failed write was meant to replace. An entry
  // exists only while a write is unpersisted; a later write that lands clears it, which is how
  // storage recovering reconciles.
  if (fallback.has(key)) return fallback.get(key) ?? null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Drop the unpersisted value for `key`, so the shared store is the source again. Called from the
 *  storage-event path: another tab's write reached the shared store, ours did not. */
export function clearFallback(key: string): void {
  fallback.delete(key)
}

/** Store a preference and tell this tab's subscribers. */
export function writeLocal(key: string, next: string | null): void {
  try {
    if (next === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, next)
    fallback.delete(key)
  } catch {
    // Storage blocked or full: hold it in memory so the choice still applies to this page. It
    // just won't survive a reload.
    fallback.set(key, next)
  }
  emit(key)
}
