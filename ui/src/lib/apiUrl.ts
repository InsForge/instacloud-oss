// The `insta login` line the Setup and Tokens pages print. Prefer `boot.apiUrl` (the daemon
// knows its own api URL); this derivation is the fallback for a shell without the injection.

/** `https://console.<domain>[:port]` -> `https://api.<domain>[:port]`; anything else (local mode,
 *  a raw IP, a LAN name) is returned unchanged. Never throws: a non-URL comes back as given. */
export function apiUrlForCli(origin: string): string {
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return origin
  }
  if (!u.hostname.startsWith('console.')) return origin
  u.hostname = `api.${u.hostname.slice('console.'.length)}`
  return u.origin
}

/** The exact line the CLI needs (insta-cli auth.ts accepts --api-url with --api-key). */
export function cliLoginLine(key: string, apiUrl: string): string {
  return `insta login --api-key ${key} --api-url ${apiUrl}`
}
