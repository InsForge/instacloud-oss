// A localStorage-backed preference as React state (the console's lib/hooks/use-local-pref.ts):
// useSyncExternalStore, so every caller of one key shares it, across tabs too. Writes notify
// same-tab subscribers (localStorage's own event only fires cross-tab). A browser that blocks site
// data makes the read throw; that is caught, so the chrome never takes the page down.
//
// The storage half lives in ./localPrefStore, which imports no react — see the note there: a test
// beside a react-importing module cannot load under the root vitest config, and a file that fails
// to load turns CI red while the test summary still reads as if nothing failed.

import { useCallback, useSyncExternalStore } from 'react'
import { clearFallback, readLocal, subscribers, writeLocal } from './localPrefStore'

export { clearFallback, readLocal, writeLocal } from './localPrefStore'

export function useLocalPref(key: string): [string | null, (value: string | null) => void] {
  const value = useSyncExternalStore(
    useCallback((onChange: () => void) => {
      const set = subscribers(key)
      set.add(onChange)
      // A `storage` event is ANOTHER tab writing the same key, and that write is authoritative: it
      // landed in the shared store, while our fallback entry exists only because ours did not.
      // Holding onto it past that point pinned this tab to a value the user had since changed or
      // cleared elsewhere, for as long as the page stayed open.
      const onStorage = (e: StorageEvent) => {
        if (e.storageArea === window.localStorage && (e.key === null || e.key === key)) clearFallback(key)
        onChange()
      }
      window.addEventListener('storage', onStorage)
      return () => {
        set.delete(onChange)
        window.removeEventListener('storage', onStorage)
      }
    }, [key]),
    () => readLocal(key),
    () => null,
  )

  const setValue = useCallback((next: string | null) => { writeLocal(key, next) }, [key])

  return [value, setValue]
}

/** A boolean preference stored as "1"/"0". */
export function useLocalFlag(key: string): [boolean, (value: boolean) => void] {
  const [raw, setRaw] = useLocalPref(key)
  const setFlag = useCallback((next: boolean) => { setRaw(next ? '1' : '0') }, [setRaw])
  return [raw === '1', setFlag]
}
