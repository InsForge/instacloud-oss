// Light / Dark / System, like the console's account menu. Class-based (`.dark` on <html>), the
// console's convention; the default is System, as it is there (measured live: a fresh console
// session follows the OS scheme). index.html applies the stored choice before first paint so the
// page never flashes the other theme.

import { useEffect } from 'react'
import { useLocalPref } from './localPref'

export type ThemePreference = 'light' | 'dark' | 'system'

export const THEME_KEY = 'insta_theme'
export const DEFAULT_THEME: ThemePreference = 'system'

export function asTheme(v: string | null): ThemePreference {
  return v === 'light' || v === 'dark' || v === 'system' ? v : DEFAULT_THEME
}

/** Whether a preference renders dark, given what the OS prefers. Pure, for the tests. */
export function isDark(pref: ThemePreference, systemDark: boolean): boolean {
  return pref === 'dark' || (pref === 'system' && systemDark)
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
}

export function applyTheme(pref: ThemePreference): void {
  const dark = isDark(pref, systemPrefersDark())
  document.documentElement.classList.toggle('dark', dark)
  // The class styles our own elements; it says nothing to the browser about the ones it draws
  // itself. Without this, choosing Dark on a light OS left scrollbars, form controls and the
  // caret in the OS scheme. `.light` subtrees (the auth pages) still override it locally.
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

export function useTheme(): { theme: ThemePreference; setTheme: (t: ThemePreference) => void } {
  const [raw, setRaw] = useLocalPref(THEME_KEY)
  const theme = asTheme(raw)
  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const follow = () => applyTheme('system')
    mq.addEventListener('change', follow)
    return () => mq.removeEventListener('change', follow)
  }, [theme])
  return { theme, setTheme: setRaw }
}
