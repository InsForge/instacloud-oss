// The loopback listener the edge consults (decision 22; contract 00 section 9, last row): server mode
// only, `127.0.0.1:<INSTA_OSS_INTERNAL_PORT>`, never registered on Fastify. Caddy's `on_demand_tls
// { ask }` calls `GET /tls/ask?domain=<host>` before issuing a certificate; 200 means the hostname is
// ours. `GET /healthz` is the compose healthcheck. Nothing else answers.
import { createServer, type Server } from 'node:http'
import { hostOnly } from './table'

export interface InternalOpts {
  ownsHostname(host: string): boolean
  log?(msg: string): void
}

export function createInternalServer(opts: InternalOpts): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method !== 'GET') { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}'); return }
    if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return }
    if (url.pathname === '/tls/ask') {
      const raw = url.searchParams.get('domain') ?? ''
      const host = hostOnly(raw)
      if (!host || host.includes('/') || host.includes(' ') || raw.length > 253) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('bad domain'); return }
      if (opts.ownsHostname(host)) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return }
      // Never logs the domain at info level: a stranger's probe is not our business to record.
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not ours'); return
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}')
  })
}
