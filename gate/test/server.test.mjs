// The gate's contract (plans/2026-10-08-ttyd-login-gate-spec.md, Behaviour). Built-ins only, so the
// root `npm test` runs it. INSTA_GATE_FILE=gate/dist/insta-gate.mjs runs the same cases against the
// built release file instead of the source.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = process.env.INSTA_GATE_FILE ? resolve(process.env.INSTA_GATE_FILE) : join(here, '..', 'src', 'server.mjs')
const { createGate, safeNext } = await import(pathToFileURL(target).href)

const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)))
// Keep-alive is on by default, so idle connections would hold close() open: drop them first.
const close = (server) =>
  new Promise((ok) => {
    server.close(() => ok())
    server.closeAllConnections()
  })

// The terminal stand-in: echoes what reached it, and accepts a WebSocket-shaped upgrade.
const upstream = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ method: req.method, url: req.url, cookie: req.headers.cookie ?? null }))
})
const upstreamSockets = []
upstream.on('upgrade', (req, socket) => {
  upstreamSockets.push(socket)
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Seen-Cookie: ${req.headers.cookie ?? ''}\r\n\r\n`)
  socket.on('data', (d) => socket.write(d))
})

let upstreamPort
const gates = []
async function startGate(overrides = {}) {
  const gate = createGate({ username: 'admin', password: 'correct horse', name: 'claude-code', upstreamPort, failDelayMs: 50, ...overrides })
  const server = createServer(gate.handle)
  server.on('upgrade', gate.upgrade)
  gates.push(server)
  return listen(server)
}

function call(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    // agent: false, so no idle keep-alive connection is left to count against the gate.
    const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', fail)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const page = (port, path = '/') => call(port, path, { headers: { accept: 'text/html,application/xhtml+xml' } })
const form = (fields) => new URLSearchParams(fields).toString()
// A header given as undefined is left out, so a case can drop the default Origin.
const signIn = (port, fields, headers = {}) =>
  call(port, '/_insta/sign-in', {
    method: 'POST',
    headers: Object.fromEntries(
      Object.entries({ 'content-type': 'application/x-www-form-urlencoded', origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, ...headers })
        .filter(([, v]) => v !== undefined),
    ),
    body: form(fields),
  })
const sessionCookie = (res) => String(res.headers['set-cookie']?.[0] ?? '').split(';')[0]

function rawUpgrade(port, cookie) {
  return new Promise((ok, fail) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}\r\n`)
    })
    let text = ''
    socket.on('data', (d) => {
      text += d.toString('utf8')
      if (text.includes('\r\n\r\n')) {
        if (text.startsWith('HTTP/1.1 101')) {
          if (!text.includes('ping')) socket.write('ping')
          else {
            socket.destroy()
            ok(text)
          }
        } else {
          socket.destroy()
          ok(text)
        }
      }
    })
    socket.on('error', fail)
  })
}

beforeAll(async () => {
  upstreamPort = await listen(upstream)
})
afterAll(async () => {
  await Promise.all(gates.map(close))
  for (const socket of upstreamSockets) socket.destroy()
  await close(upstream)
})

describe('without a session', () => {
  it('a page load gets the sign-in page, uncached and framed by a CSP', async () => {
    const port = await startGate()
    const res = await page(port, '/?arg=1')
    expect(res.status).toBe(200)
    expect(res.body).toContain('Sign in to')
    expect(res.body).toContain('claude-code')
    expect(res.body).toContain('value="/?arg=1"')
    expect(res.body).not.toContain('Incorrect username or password')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
  })

  it("anything else is a bare 401, ttyd's /token included", async () => {
    const port = await startGate()
    const res = await call(port, '/token')
    expect(res.status).toBe(401)
    expect(res.body).toBe('')
  })

  it('the health check (/) answers below 500 either way', async () => {
    const port = await startGate()
    expect((await call(port, '/')).status).toBeLessThan(500)
    expect((await page(port)).status).toBeLessThan(500)
  })

  it('the WebSocket upgrade is refused', async () => {
    const port = await startGate()
    expect(await rawUpgrade(port)).toMatch(/^HTTP\/1\.1 401/)
  })

  it('the template name is escaped into the page', async () => {
    const port = await startGate({ name: '<b>x</b>' })
    const res = await page(port)
    expect(res.body).not.toContain('<b>x</b>')
    expect(res.body).toContain('&#60;b&#62;x&#60;/b&#62;')
  })
})

describe('signing in', () => {
  it('wrong credentials get the page with the error, a 401, after the delay', async () => {
    const port = await startGate()
    const started = Date.now()
    const res = await signIn(port, { username: 'admin', password: 'wrong', next: '/' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
    expect(res.status).toBe(401)
    expect(res.body).toContain('Incorrect username or password')
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('a failed attempt keeps the username, escaped, and never echoes the password', async () => {
    const port = await startGate()
    const res = await signIn(port, { username: 'ad"min<', password: 'secret-typo' })
    expect(res.body).toContain('value="ad&#34;min&#60;"')
    expect(res.body).not.toContain('secret-typo')
    expect((await page(port)).body).toMatch(/name="username"[^>]*value=""|value=""[^>]*name="username"/)
  })

  it('a right password with the wrong username is still wrong', async () => {
    const port = await startGate()
    const res = await signIn(port, { username: 'root', password: 'correct horse' })
    expect(res.status).toBe(401)
  })

  it('right credentials set the session cookie and return to the page asked for', async () => {
    const port = await startGate()
    const res = await signIn(port, { username: 'admin', password: 'correct horse', next: '/?arg=1' })
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe('/?arg=1')
    const cookie = String(res.headers['set-cookie'][0])
    expect(cookie).toMatch(/^insta_gate=\d+\.[\w-]+;/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).not.toContain('Secure')
  })

  it('the cookie is Secure when the router says the request came over HTTPS', async () => {
    const port = await startGate()
    const res = await signIn(port, { username: 'admin', password: 'correct horse' }, {
      'x-forwarded-proto': 'https',
      origin: `https://127.0.0.1:${port}`,
    })
    expect(res.status).toBe(303)
    expect(String(res.headers['set-cookie'][0])).toContain('Secure')
  })

  it('an off-origin POST is refused before credentials are looked at', async () => {
    const port = await startGate()
    const res = await signIn(port, { username: 'admin', password: 'correct horse' }, { origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('the router-forwarded host counts as the origin', async () => {
    const port = await startGate()
    const res = await signIn(port, { username: 'admin', password: 'correct horse' }, {
      origin: 'https://prod-main-claude-code-abc.compute.instacloud-edge.com',
      'x-forwarded-host': 'prod-main-claude-code-abc.compute.instacloud-edge.com',
      'x-forwarded-proto': 'https',
    })
    expect(res.status).toBe(303)
  })

  it('an https deployment refuses an http Origin for the same host', async () => {
    const port = await startGate()
    const res = await signIn(port, { username: 'admin', password: 'correct horse' }, {
      origin: 'http://prod-main-claude-code-abc.compute.instacloud-edge.com',
      'x-forwarded-host': 'prod-main-claude-code-abc.compute.instacloud-edge.com',
      'x-forwarded-proto': 'https',
    })
    expect(res.status).toBe(403)
  })

  it('a POST with neither Origin nor Sec-Fetch-Site is refused', async () => {
    const port = await startGate()
    const res = await signIn(port, { username: 'admin', password: 'correct horse' }, { origin: undefined })
    expect(res.status).toBe(403)
  })

  it('without Origin, only Sec-Fetch-Site: same-origin is let through', async () => {
    const port = await startGate()
    const fields = { username: 'admin', password: 'correct horse' }
    expect((await signIn(port, fields, { origin: undefined, 'sec-fetch-site': 'same-origin' })).status).toBe(303)
    expect((await signIn(port, fields, { origin: undefined, 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await signIn(port, fields, { origin: undefined, 'sec-fetch-site': 'same-site' })).status).toBe(403)
  })

  it('an opaque Origin (null) is refused', async () => {
    const port = await startGate()
    const res = await signIn(port, { username: 'admin', password: 'correct horse' }, { origin: 'null' })
    expect(res.status).toBe(403)
  })

  it('an oversized form is refused', async () => {
    const port = await startGate()
    const res = await signIn(port, { username: 'admin', password: 'x'.repeat(5000) })
    expect(res.status).toBe(413)
  })

  it('only a same-origin path survives as the return target', () => {
    expect(safeNext('/a?b=1')).toBe('/a?b=1')
    expect(safeNext('//evil.example')).toBe('/')
    expect(safeNext('/\\evil.example')).toBe('/')
    expect(safeNext('https://evil.example')).toBe('/')
    expect(safeNext('/_insta/sign-out')).toBe('/')
    expect(safeNext('/a\nb')).toBe('/')
    expect(safeNext(null)).toBe('/')
  })
})

describe('with a session', () => {
  it('requests reach the terminal unchanged, minus the gate cookie', async () => {
    const port = await startGate()
    const cookie = sessionCookie(await signIn(port, { username: 'admin', password: 'correct horse' }))
    const res = await call(port, '/token?x=1', { headers: { cookie: `theme=dark; ${cookie}` } })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ method: 'GET', url: '/token?x=1', cookie: 'theme=dark' })
  })

  it('the WebSocket upgrade is joined to the terminal', async () => {
    const port = await startGate()
    const cookie = sessionCookie(await signIn(port, { username: 'admin', password: 'correct horse' }))
    const text = await rawUpgrade(port, cookie)
    expect(text).toMatch(/^HTTP\/1\.1 101/)
    expect(text).toContain('ping')
    expect(text).not.toContain('insta_gate')
  })

  // The stand-in stays half-open on purpose, the worst case: the gate must let go by itself.
  it('closing the tab releases both connections', async () => {
    const port = await startGate()
    const server = gates.at(-1)
    const cookie = sessionCookie(await signIn(port, { username: 'admin', password: 'correct horse' }))
    const before = upstreamSockets.length
    await rawUpgrade(port, cookie)
    const sock = upstreamSockets[before]
    const open = () => new Promise((ok) => server.getConnections((_e, n) => ok(n)))
    for (let i = 0; i < 40 && ((await open()) > 0 || !sock.readableEnded); i++) await new Promise((r) => setTimeout(r, 50))
    expect(await open()).toBe(0)
    expect(sock.readableEnded).toBe(true)
  })

  it('a session survives a restart: the key comes from the credentials, not the boot', async () => {
    const first = await startGate()
    const cookie = sessionCookie(await signIn(first, { username: 'admin', password: 'correct horse' }))
    const second = await startGate()
    expect((await call(second, '/token', { headers: { cookie } })).status).toBe(200)
  })

  it('changing the password ends every session', async () => {
    const before = await startGate()
    const cookie = sessionCookie(await signIn(before, { username: 'admin', password: 'correct horse' }))
    const after = await startGate({ password: 'battery staple' })
    expect((await call(after, '/token', { headers: { cookie } })).status).toBe(401)
  })

  it('a forged or expired cookie is refused', async () => {
    const port = await startGate()
    const cookie = sessionCookie(await signIn(port, { username: 'admin', password: 'correct horse' }))
    const [exp, sig] = cookie.slice('insta_gate='.length).split('.')
    const forged = `insta_gate=${Number(exp) + 1000}.${sig}`
    expect((await call(port, '/token', { headers: { cookie: forged } })).status).toBe(401)
    const later = await startGate({ now: () => Date.now() + 31 * 24 * 60 * 60 * 1000 })
    expect((await call(later, '/token', { headers: { cookie } })).status).toBe(401)
  })

  it('signing out clears the cookie', async () => {
    const port = await startGate()
    const res = await call(port, '/_insta/sign-out')
    expect(res.status).toBe(303)
    expect(String(res.headers['set-cookie'][0])).toMatch(/^insta_gate=; .*Max-Age=0/)
  })
})

describe('as the container process', () => {
  const env = { PATH: process.env.PATH, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'pw' }
  const run = (args, extra) =>
    spawnSync(process.execPath, [target, ...args], { env: { PATH: process.env.PATH, ...extra }, encoding: 'utf8', timeout: 20_000 })
  const free = () =>
    new Promise((ok) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address()
        s.close(() => ok(port))
      })
    })
  // Polls until the gate serves its page, or returns the last status (0: nothing answered).
  const pageWhenUp = async (port) => {
    let status = 0
    for (let i = 0; i < 100 && status === 0; i++) {
      status = await page(port).then((r) => r.status, () => 0)
      if (status === 0) await new Promise((r) => setTimeout(r, 100))
    }
    return status
  }

  it('refuses to start without both credentials', () => {
    const res = run(['--name', 't', '--', process.execPath, '-e', ''], { ADMIN_USERNAME: 'admin' })
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('ADMIN_USERNAME and ADMIN_PASSWORD are required')
  })

  it('a terminal that stays up but never listens is a failed start, and is stopped with the gate', () => {
    const started = Date.now()
    // spawnSync waits for every holder of the inherited stdio, so a surviving child would hang this.
    const res = run(['--name', 't', '--port', '0', '--upstream-port', '1', '--ready-timeout', '1', '--', process.execPath, '-e', 'setInterval(() => {}, 1000)'], env)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('the terminal did not open 127.0.0.1:1 within 1s')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('starts listening once a slow terminal opens its port', async () => {
    const [gatePort, termPort] = [await free(), await free()]
    const terminal = `setTimeout(() => require('node:http').createServer((q, s) => s.end('ok')).listen(${termPort}, '127.0.0.1'), 500)`
    const child = spawn(process.execPath, [target, '--name', 't', '--port', String(gatePort), '--upstream-port', String(termPort), '--', process.execPath, '-e', terminal], { env, stdio: 'ignore' })
    try {
      expect(await pageWhenUp(gatePort)).toBe(200)
    } finally {
      child.kill('SIGTERM')
    }
  })

  // The platform stops a container by signalling its main process, which is the gate: the terminal
  // must hear it too, and the gate must leave with the terminal's status.
  it.each(['SIGTERM', 'SIGINT', 'SIGHUP'])('forwards %s to the terminal and exits with its status', async (sig) => {
    const [gatePort, termPort] = [await free(), await free()]
    const terminal = `for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => { process.stdout.write('terminal got ' + s); process.exit(7) });`
      + ` require('node:http').createServer((q, r) => r.end('ok')).listen(${termPort}, '127.0.0.1')`
    const child = spawn(process.execPath, [target, '--name', 't', '--port', String(gatePort), '--upstream-port', String(termPort), '--', process.execPath, '-e', terminal], { env, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    const exited = new Promise((ok) => child.on('exit', (code, signal) => ok({ code, signal })))
    try {
      expect(await pageWhenUp(gatePort)).toBe(200)
      child.kill(sig)
      const { code, signal } = await exited
      expect(out).toContain(`terminal got ${sig}`)
      expect({ code, signal }).toEqual({ code: 7, signal: null })
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('exits with the terminal process status', () => {
    const res = run(['--name', 't', '--port', '0', '--upstream-port', '1', '--', process.execPath, '-e', 'process.exit(3)'], env)
    expect(res.status).toBe(3)
  })
})
