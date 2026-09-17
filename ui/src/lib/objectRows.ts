// Row shaping for the storage Buckets tab (the console's bucket file browser). Pure so the root
// vitest covers it: the daemon's object listing carries only { key, size, lastModified, etag }
// (flat S3 list-type=2, no contentType), so the display name, the Type column and the upload
// contentType are all derived here from the key.

/** One entry of `GET /objects` (`ObjectListing.objects`, src/types.ts). */
export type ObjectEntry = { key: string; size: number; lastModified: string; etag: string }

/** What the Files table renders per object. */
export type ObjectRow = ObjectEntry & { name: string; type: string; sizeText: string }

/** The storage service's bucket, from the `host[:port]/bucket` endpoint the services list reports
 *  (decision 40: never a URL). Null when the endpoint is missing or carries no bucket segment. */
export function bucketFromEndpoint(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null
  const slash = endpoint.indexOf('/')
  if (slash < 0) return null
  const bucket = endpoint.slice(slash + 1).trim()
  return bucket || null
}

/** Binary-ish display like the console's Size column: whole bytes, one decimal from KB up. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let i = -1
  do { v /= 1024; i++ } while (v >= 1024 && i < units.length - 1)
  return `${v.toFixed(1)} ${units[i]}`
}

// Extension → MIME, for the Type column and for the presigned upload's contentType when the
// browser reports none. Small on purpose: anything else is application/octet-stream territory.
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
  webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', xml: 'application/xml',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
}

/** MIME guessed from the key's extension; null when there is nothing to guess from. */
export function contentTypeFor(key: string): string | null {
  const base = key.slice(key.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  return MIME[base.slice(dot + 1).toLowerCase()] ?? null
}

/** The upload's contentType: what the browser says, else the extension, else octet-stream —
 *  the daemon requires one (`contentType is required`). */
export function uploadContentType(fileName: string, browserType: string | null | undefined): string {
  return browserType || contentTypeFor(fileName) || 'application/octet-stream'
}

/** Listing entries → display rows, filtered by the Files search. The filter matches the full key,
 *  so a `logos/acme.png` still answers a search for "logos". S3 lists keys ascending already. */
export function objectRows(objects: ObjectEntry[], search: string): ObjectRow[] {
  const query = search.trim().toLowerCase()
  return objects
    .filter((o) => !query || o.key.toLowerCase().includes(query))
    .map((o) => ({
      ...o,
      name: o.key.slice(o.key.lastIndexOf('/') + 1) || o.key,
      type: contentTypeFor(o.key) ?? '—',
      sizeText: formatBytes(o.size),
    }))
}
