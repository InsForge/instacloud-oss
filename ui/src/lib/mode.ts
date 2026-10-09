// Run mode and first-run flags. The daemon injects `window.__INSTA_OSS__` into index.html
// (contract decision 8); the Vite dev server has no daemon shell, so `VITE_INSTA_MODE` stands in.
// Pure: every input is a parameter so the module runs under the root vitest config.

export type RunMode = 'local' | 'server'

export interface Boot {
  mode: RunMode
  /** Server mode before the admin exists: the gate sends every visit to /setup. */
  setupRequired: boolean
  /** What `insta login --api-url` should be told (server: https://api.<domain>). */
  apiUrl: string
  consoleUrl: string
  /** Whether a new compute service is always-on unless switched off (the daemon's
   *  INSTA_OSS_ALWAYS_ON_DEFAULT, on by default like the hosted platform). */
  alwaysOnDefault: boolean
}

export type BootWindow = {
  __INSTA_OSS__?: Partial<Boot> | null
  location?: { origin: string }
}

declare global {
  interface Window { __INSTA_OSS__?: Partial<Boot> | null }
}

// Literal `import.meta.env.VITE_*`, never an alias: Vite fills these in only where that exact text
// appears. Read through a cast or a key looked up at runtime, a build with VITE_INSTA_MODE and
// VITE_INSTA_ALWAYS_ON_DEFAULT set carried neither (checked by grepping the bundle for a marker).
function envMode(): string | undefined {
  return import.meta.env.VITE_INSTA_MODE
}

function envAlwaysOn(): string | undefined {
  return import.meta.env.VITE_INSTA_ALWAYS_ON_DEFAULT
}

function asMode(v: unknown): RunMode {
  return v === 'server' ? 'server' : 'local'
}

/** `window.__INSTA_OSS__` when the daemon served the shell, else the dev fallback (local mode,
 *  no setup, both URLs = the page origin). Missing fields inside an injected object fall back
 *  the same way, so a partial injection never yields `undefined` URLs. */
export function readBoot(
  win: BootWindow | undefined = typeof window === 'undefined' ? undefined : (window as BootWindow),
  fallbackMode: string | undefined = envMode(),
  fallbackAlwaysOn: string | undefined = envAlwaysOn(),
): Boot {
  const origin = win?.location?.origin ?? ''
  const injected = win?.__INSTA_OSS__
  if (injected) {
    return {
      mode: asMode(injected.mode),
      setupRequired: injected.setupRequired === true,
      apiUrl: injected.apiUrl ?? origin,
      consoleUrl: injected.consoleUrl ?? origin,
      // ON only when the daemon says so. A shell without the field comes from a daemon older than
      // the field, and that daemon's default was OFF: reading a missing field as on made the add
      // dialog show "Always on" for a service that daemon then created scale-to-zero.
      alwaysOnDefault: injected.alwaysOnDefault === true,
    }
  }
  // No shell means the Vite dev server, which proxies to a daemon it cannot ask; the value comes
  // from VITE_INSTA_ALWAYS_ON_DEFAULT (set it to 0 for a daemon running INSTA_OSS_ALWAYS_ON_DEFAULT=0),
  // and unset it matches the daemon's own default, on.
  const alwaysOnDefault = fallbackAlwaysOn === undefined || !['0', 'false'].includes(fallbackAlwaysOn.trim().toLowerCase())
  return { mode: asMode(fallbackMode), setupRequired: false, apiUrl: origin, consoleUrl: origin, alwaysOnDefault }
}
