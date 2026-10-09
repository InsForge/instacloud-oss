// insta-gate: the InstaCloud sign-in page in front of a browser terminal (ttyd).
// Node built-ins only, so it runs on the template's base image with no npm install.
// Spec: plans/2026-10-08-ttyd-login-gate-spec.md
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'

// Replaced by gate/page/build.mjs with the rendered page; the source keeps a bare fallback so tests
// and a dev run work without building the page.
const BUILT = null

const SIGN_IN = '/_insta/sign-in'
const SIGN_OUT = '/_insta/sign-out'
const COOKIE = 'insta_gate'
const NAME_MARK = '__INSTA_NAME__'
const NEXT_MARK = '__INSTA_NEXT__'
const USER_MARK = '__INSTA_USER__'
const ERROR_MARK = '<!--insta:error-->'
const MAX_FORM_BYTES = 4096

const FALLBACK = {
  page: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in to ${NAME_MARK}</title></head>`
    + `<body><form method="post" action="${SIGN_IN}"><p>Sign in to ${NAME_MARK}</p>${ERROR_MARK}`
    + `<input type="hidden" name="next" value="${NEXT_MARK}">`
    + `<label for="username">Username</label><input id="username" name="username" value="${USER_MARK}" autocomplete="username">`
    + '<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">'
    + '<button type="submit">Sign In</button></form></body></html>',
  errorHtml: '<p role="alert">Incorrect username or password</p>',
  scriptHashes: [],
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** A same-origin path to return to after signing in, or `/`. */
export function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/'
  if (value.startsWith('//') || value.startsWith('/\\') || value.startsWith('/_insta/')) return '/'
  if (/[\u0000-\u001f\u007f]/.test(value) || value.length > 2048) return '/'
  return value
}

function parseCookies(header) {
  const out = {}
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

/** The Cookie header with the gate's own cookie removed, or undefined when nothing is left. */
function withoutGateCookie(header) {
  if (header === undefined) return undefined
  const kept = String(header).split(';').map((p) => p.trim()).filter((p) => p && !p.startsWith(`${COOKIE}=`))
  return kept.length ? kept.join('; ') : undefined
}

/**
 * The gate as a request handler pair. Credentials stay inside: they derive the session key and the
 * comparison digests, and are never logged or echoed.
 */
export function createGate({
  username,
  password,
  name,
  upstreamHost = '127.0.0.1',
  upstreamPort,
  sessionDays = 30,
  failDelayMs = 1000,
  now = () => Date.now(),
  built = BUILT ?? FALLBACK,
}) {
  if (!username || !password) throw new Error('username and password are required')
  // Derived from both credentials, so sessions survive restarts and a changed credential ends them.
  const sessionKey = createHmac('sha256', 'insta-gate/session/v1').update(JSON.stringify([username, password])).digest()
  // Per process: only equalises the lengths timingSafeEqual compares.
  const compareKey = randomBytes(32)
  const digest = (v) => createHmac('sha256', compareKey).update(String(v)).digest()
  const wantUser = digest(username)
  const wantPass = digest(password)

  const sign = (exp) => createHmac('sha256', sessionKey).update(String(exp)).digest('base64url')
  const issue = () => {
    const exp = now() + sessionDays * 24 * 60 * 60 * 1000
    return `${exp}.${sign(exp)}`
  }
  const valid = (value) => {
    if (typeof value !== 'string') return false
    const [exp, sig] = value.split('.')
    if (!/^\d+$/.test(exp ?? '') || !sig || Number(exp) <= now()) return false
    const want = Buffer.from(sign(exp))
    const got = Buffer.from(sig)
    return got.length === want.length && timingSafeEqual(got, want)
  }
  const signedIn = (req) => valid(parseCookies(req.headers.cookie)[COOKIE])
  const credentialsMatch = (u, p) => {
    const userOk = timingSafeEqual(digest(u), wantUser)
    const passOk = timingSafeEqual(digest(p), wantPass)
    return userOk && passOk
  }

  // The origin the browser addressed. The platform router and the self-hosted one both set the
  // X-Forwarded pair; a comma list keeps its first, outermost value.
  const first = (v) => (v === undefined ? undefined : String(v).split(',')[0].trim())
  const scheme = (req) => first(req.headers['x-forwarded-proto']) ?? (req.socket.encrypted ? 'https' : 'http')
  const https = (req) => scheme(req) === 'https'
  const servedOrigin = (req) => {
    const host = first(req.headers['x-forwarded-host']) ?? req.headers.host
    try {
      return host ? new URL(`${scheme(req)}://${host}`).origin : undefined
    } catch {
      return undefined
    }
  }
  const cookieHeader = (req, value, maxAge) =>
    `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${https(req) ? '; Secure' : ''}`

  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    `script-src ${built.scriptHashes.map((h) => `'${h}'`).join(' ') || "'none'"}`,
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ')

  // After a failed attempt the username stays filled in, so only the password is retyped.
  const renderPage = (next, error, user = '') =>
    built.page
      .replaceAll(NAME_MARK, escapeHtml(name))
      .replaceAll(NEXT_MARK, escapeHtml(next))
      .replaceAll(USER_MARK, escapeHtml(user))
      .replace(ERROR_MARK, error ? built.errorHtml : '')

  const sendPage = (res, status, next, error, user) => {
    const body = renderPage(next, error, user)
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'content-security-policy': csp,
    })
    res.end(body)
  }

  // A sign-in must prove it came from this page: the whole Origin (scheme, host, port) matches the
  // one served, or with no Origin, the browser says same-origin. A request with neither is refused.
  const sameOrigin = (req) => {
    const origin = req.headers.origin
    if (origin !== undefined) {
      const want = servedOrigin(req)
      try {
        return want !== undefined && new URL(origin).origin === want
      } catch {
        return false
      }
    }
    return req.headers['sec-fetch-site'] === 'same-origin'
  }

  const signIn = (req, res) => {
    if (!sameOrigin(req)) {
      res.writeHead(403, { 'cache-control': 'no-store' }).end()
      return
    }
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_FORM_BYTES) {
        res.writeHead(413, { connection: 'close' }).end()
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (res.writableEnded) return
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      const next = safeNext(form.get('next'))
      const user = form.get('username') ?? ''
      if (credentialsMatch(user, form.get('password') ?? '')) {
        res.writeHead(303, {
          location: next,
          'set-cookie': cookieHeader(req, issue(), sessionDays * 24 * 60 * 60),
          'cache-control': 'no-store',
        }).end()
        return
      }
      setTimeout(() => sendPage(res, 401, next, true, user), failDelayMs)
    })
  }

  const proxy = (req, res) => {
    const headers = { ...req.headers }
    const cookie = withoutGateCookie(headers.cookie)
    if (cookie === undefined) delete headers.cookie
    else headers.cookie = cookie
    const up = httpRequest({ host: upstreamHost, port: upstreamPort, method: req.method, path: req.url, headers }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers)
      upRes.pipe(res)
    })
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'cache-control': 'no-store' })
      res.end()
    })
    req.pipe(up)
  }

  const handle = (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path === SIGN_IN && req.method === 'POST') return signIn(req, res)
    if (path === SIGN_OUT) {
      res.writeHead(303, { location: '/', 'set-cookie': cookieHeader(req, '', 0), 'cache-control': 'no-store' }).end()
      return
    }
    if (signedIn(req)) return proxy(req, res)
    const wantsPage = (req.method === 'GET' || req.method === 'HEAD') && /text\/html/.test(req.headers.accept ?? '')
    if (wantsPage) return sendPage(res, 200, safeNext(req.url), false)
    res.writeHead(401, { 'cache-control': 'no-store', 'content-length': 0 }).end()
  }

  const upgrade = (req, socket, head) => {
    if (!signedIn(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const up = connect(upstreamPort, upstreamHost, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i]
        let value = req.rawHeaders[i + 1]
        if (key.toLowerCase() === 'cookie') {
          value = withoutGateCookie(value)
          if (value === undefined) continue
        }
        lines.push(`${key}: ${value}`)
      }
      up.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head?.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    up.setNoDelay(true)
    // http.Server sockets allow half-open, so a client that leaves only sends 'end': without
    // closing both sides here, the terminal connection would outlive every closed tab.
    const close = () => {
      up.destroy()
      socket.destroy()
    }
    for (const side of [up, socket]) {
      side.on('error', close)
      side.on('end', close)
      side.on('close', close)
    }
  }

  return { handle, upgrade }
}

function parseArgs(argv) {
  const opts = { name: 'terminal', port: 7681, upstreamPort: 7682, readyTimeout: 30, command: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      opts.command = argv.slice(i + 1)
      break
    }
    if (arg === '--name') opts.name = argv[++i]
    else if (arg === '--port') opts.port = Number(argv[++i])
    else if (arg === '--upstream-port') opts.upstreamPort = Number(argv[++i])
    else if (arg === '--ready-timeout') opts.readyTimeout = Number(argv[++i])
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

const waitForPort = (port, host, deadline) =>
  new Promise((resolve) => {
    const attempt = () => {
      const s = connect(port, host)
      s.once('connect', () => {
        s.destroy()
        resolve(true)
      })
      s.once('error', () => {
        s.destroy()
        if (Date.now() > deadline) resolve(false)
        else setTimeout(attempt, 100)
      })
    }
    attempt()
  })

/** `insta-gate --name claude-code [--port 7681] [--upstream-port 7682] [--ready-timeout 30] -- <terminal command>` */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv)
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    console.error('insta-gate: ADMIN_USERNAME and ADMIN_PASSWORD are required')
    process.exit(1)
  }
  if (!opts.command.length) {
    console.error('insta-gate: missing the terminal command after --')
    process.exit(1)
  }
  const child = spawn(opts.command[0], opts.command.slice(1), { stdio: 'inherit' })
  child.on('error', (err) => {
    console.error(`insta-gate: could not start ${opts.command[0]}: ${err.message}`)
    process.exit(1)
  })
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig))

  const gate = createGate({
    username: env.ADMIN_USERNAME,
    password: env.ADMIN_PASSWORD,
    name: opts.name,
    upstreamPort: opts.upstreamPort,
  })
  const server = createServer(gate.handle)
  server.on('upgrade', gate.upgrade)
  child.on('exit', (code, signal) => {
    server.close()
    process.exit(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1))
  })
  // Listen only once the terminal answers. A terminal that never does is a failed start: answering
  // the health check anyway would report a deploy healthy whose every signed-in request is a 502.
  if (!(await waitForPort(opts.upstreamPort, '127.0.0.1', Date.now() + opts.readyTimeout * 1000))) {
    console.error(`insta-gate: the terminal did not open 127.0.0.1:${opts.upstreamPort} within ${opts.readyTimeout}s`)
    child.kill('SIGTERM')
    process.exit(1)
  }
  server.listen(opts.port, '0.0.0.0', () => {
    console.log(`insta-gate: ${opts.name} on :${opts.port}, terminal on 127.0.0.1:${opts.upstreamPort}`)
  })
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (invokedDirectly) await main()
