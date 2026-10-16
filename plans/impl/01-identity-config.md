# 01 WP1: identity, config and run modes

Contract: `00-contract.md` sections 3, 5, 6, 9 (WP1 rows), 11, 15. Design source: `designs/wp1.json`, adjusted to the decisions register (1, 3, 8, 9, 12, 30, 36, 43). Merge position: first after the scaffold.

## Scope

- `src/config.ts` is landed by the scaffold exactly as contract section 3. WP1 owns it from then on and adds nothing unless another package files a need in `00-contract.md` first.
- Server-mode identity: first-visit admin creation through the cloud's Better Auth mount path, sign-in / get-session / sign-out on the same mount, the cloud's `/auth/login|refresh|logout` wrappers for `insta login --email`, `GET/POST/DELETE /tokens` minting `insta_` keys, `/me` returning the admin as the cloud's `PublicUser` with `via`, and a bearer-or-signed-cookie guard on every route outside the allowlist.
- Local mode stays byte-identical: 127.0.0.1, no guard, `/me` = local, `/tokens` 501.
- `src/state.ts`: atomic tmp+rename write, sync-only assertion for `mutate()`, heartbeat lock file (fresh-lock retry for the container restart case), coalesced `touchLater`, stat-keyed parse cache, `rev` + `auditRev` (routing vs audit writes, decision 54), `stateRev()` with no clone, `onSave` subscribers, `EVENTS_CAP`, `initStatePath`. Regions for WP2 (`customDomains`, `lanes`) and WP5 (`templateDeployments`, `migrateState`) are left as marked stubs (`customDomains: {}`, `templateDeployments: {}`, `migrateState = (s) => s`).
- `src/main.ts` rewrite: boot order, listen addresses, banner, `--reset-admin`, SIGTERM handling; every other package adds lines only inside its region.
- SPA shell injection (`window.__INSTA_OSS__`) in `server.ts` region A.

No new dependency (node:crypto scrypt, HMAC, randomBytes).

## Files

Owned (create or rewrite):
- `src/identity.ts` (new, pure): scrypt hash/verify with constant-time compare and a fixed dummy hash for unknown-email timing parity; session mint/verify/slide/revoke; `insta_` token mint/verify/revoke/list; signed-cookie encode/decode in Better Auth's format; output mappers `publicUser`, `betterAuthUser`, `sessionOut`, `apiTokenOut`; in-memory per-IP sign-in failure limiter; injectable `now()`.
- `src/auth.ts` (new): `registerAuth(app: FastifyInstance, cfg: Config): void`: the `onRequest` guard (server mode only), `/api/auth/{sign-up/email,sign-in/email,get-session,sign-out,device/code}`, `/auth/{login,refresh,logout,signup}`, `/me`, `/tokens` GET/POST/DELETE. In local mode registers exactly today's `/me` and the three `/tokens` 501s and no hook. Decorates `req.actor?: { userId: string; via: 'jwt' | 'api'; scopes?: string[]; source: 'bearer' | 'cookie' }`.
- `src/state.ts` (rewrite per contract section 5).
- `src/main.ts` (rewrite; regions for WP2..WP6 left as marked comment blocks).
- `test/identity.test.ts`, `test/server-auth.test.ts`, `test/state-lock.test.ts` (new); `test/config.test.ts` (extend the scaffold's).

Shared (append inside region):
- `src/server.ts` region A, plus the three in-place edits the ownership table names (contract 1.2): `buildServer(engine, cfg = loadConfig(), opts = {})` (scaffold), `Fastify({ logger: false, trustProxy: cfg.trustProxy, forceCloseConnections: 'idle', serverFactory: opts.serverFactory })`, delete the `/me` and `/tokens` 501 stubs the scaffold already moved INTO region A (contract 1.1) and call `registerAuth(app, cfg)` right after the content-type parser (line 33); the `// WP1` line of `API_PREFIXES` gains `/api`, `/auth`, `/tls` (WP5 owns the `/templates`, `/template-deployments` line); `uiDist` from `cfg.uiDist`; shell injection (below).
- `src/types.ts` region WP1: nothing (identity types live in `state.ts`/`identity.ts`).
- `test/server.test.ts` region WP1: the local-mode parity tests listed below.
- `test/fakes.ts` region WP1: `serverConfig()` helper (contract section 6) if the scaffold did not include it.

## Algorithm

### 1. Boot (`src/main.ts`)

The scaffold already lays out `main.ts` with every region marker in this order (contract 1.1); WP1 fills the bodies and moves no marker.

1. `cfg = loadConfig()`; if `argv` has `--reset-admin` run section 8 and exit.
2. `mkdirSync(cfg.dataDir, { recursive: true })`; `initStatePath(cfg.statePath)`; `acquireLock(cfg.dataDir)` (retries a fresh lock for up to 60 s, section 7: the compose restart case).
3. Docker check as today (`docker version`).
4. `extraListenHosts`: local mode on linux: `docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}'` -> `[gateway]` (empty on failure, logged once); otherwise `[]`. Stored on a copy of `cfg` (`cfg = { ...cfg, extraListenHosts }`, frozen again).
5. Placeholder blocks in the contract's final order (00 §1.1): `// region WP4 (probe)` (DataDir + probe), `// region WP3 (upstream)` (`Upstream`, `DockerRuntime`), `// region WP5 (catalog)` BEFORE the engine; today's adapters are constructed with `cfg` (`new LocalGarage({ configPath: cfg.garageConfigPath, hostEndpoint: cfg.s3HostEndpoint, mode: cfg.mode, domain: cfg.domain })`, the last two unused until WP5).
6. `engine = new Engine(db, compute, storage, managed, { cfg })` (WP4/WP3/WP5 add `data`, `upstream`, `templates` to this object from their pre-engine blocks); then `// region WP4 (migrate)`, `// region WP5 (executor)`, `// region WP2 (router)` (the router needs engine methods, so it is constructed here); `app = buildServer(engine, cfg)` (WP2 adds the `{ serverFactory }` argument); `await app.listen({ host: cfg.listenHost, port: cfg.port })`; then `// region WP2 (start)` and `// region WP3 (start)`.
7. Banner: local = today's three lines verbatim (main.ts:22-24). Server = `instad <version> mode=server api=<apiUrl> console=<consoleUrl> data=<dataDir>` and, while `loadState().identity?.admin` is null, `setup: <consoleUrl>/setup`. `// ---- region WP6 ----` after it.
8. `SIGTERM`/`SIGINT`, in THIS order so shutdown fits the compose `stop_grace_period: 30s` and never leaves a fresh lock behind: `// region WP2 (stop): await router.stop()` first (stop accepting, destroy lane sockets, answer held wake requests 503 / ErrorResponse 57P03), then `// region WP3 (stop): await scheduler.stop()`, then `await Promise.race([app.close(), sleep(10_000)])` with Fastify's `forceCloseConnections: 'idle'` (in-flight requests and long-lived SSE/WebSocket/pg splices share the router's `node:http`/net servers, so an unbounded `close()` could exceed 30 s, get SIGKILLed, skip `releaseLock` and make the replacement container refuse the lock), then `releaseLock()`, `exit(0)`. `process.on('exit', releaseLock)`.

### 2. Identity primitives (`src/identity.ts`)

- Alphabets: `SESSION_ALPHABET` a-zA-Z0-9 (Better Auth `generateId`), `KEY_ALPHABET` a-zA-Z (api-key plugin default). `randomAlpha(n, alphabet)` uses rejection sampling over `randomBytes`.
- `hashPassword(pw)`: `scryptSync(pw.normalize('NFKC'), salt16, 64, { N: 16384, r: 8, p: 1, maxmem: 64 MiB })` -> `scrypt$16384$8$1$<salt b64url>$<key b64url>`. `verifyPassword` recomputes with the stored parameters and `timingSafeEqual`s; different lengths return false. `DUMMY_HASH` computed once at module load and verified against on unknown email.
- Password policy: 8..256 chars else 400 `{code:'PASSWORD_TOO_SHORT'|'PASSWORD_TOO_LONG'}`. Email: trim + lowercase, `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` else 400 `{code:'INVALID_EMAIL'}`.
- Admin creation (one `mutate`): `identity ??= EMPTY_IDENTITY`; admin present -> `AdminExists`; `id = identity.previousAdminId ?? randomAlpha(32)`; row `{id, email, name: name?.trim() || local part, passwordHash, createdAt, updatedAt}`; mint a session in the same mutate (autoSignIn).
- Sessions: `mintSession(s, userId, ip, ua, rememberMe = true)` -> token `randomAlpha(32)`, row `{id: uuid, tokenHash: sha256hex(token), userId, createdAt, updatedAt, expiresAt: now + (rememberMe ? sessionTtlSec : 86400) s, ipAddress, userAgent}`; GC expired rows on every mint. `findSession(s, token)`: by hash; expired -> `touchLater(delete)` and null; `now - updatedAt >= sessionUpdateAgeSec` -> `touchLater(slide updatedAt/expiresAt)`; return row. `revokeSession(s, token)`, `revokeAllSessions(s)`.
- Tokens: `mintToken(s, {name, scopes, expiresInDays})`: name trimmed 1..100 else 400 `name is required` / `name too long`; `expiresInDays` undefined -> null, else integer 1..3650 else 400; key `'insta_' + randomAlpha(64, KEY_ALPHABET)`; row `{id: uuid, name, prefix: 'insta_', keyHash: sha256hex(key), orgId: null, scopes: scopes ?? [], lastUsedAt: null, expiresAt, revokedAt: null, createdAt}` unshifted (newest first). `verifyToken(s, key)`: cheap regex reject `/^insta_[A-Za-z]{64}$/`, hash lookup, null when revoked/expired, `touchLater(lastUsedAt = now)` on success. `revokeToken(s, id)`: sets `revokedAt` once, false when unknown or already revoked (404). Scopes are stored and echoed, never enforced (documented).
- Cookie: name `cfg.auth.cookieName`; value `encodeURIComponent(`${token}.${base64(hmacSha256(secret, token))}`)`; attributes `Path=/; HttpOnly; SameSite=Lax; Max-Age=<ttl>` (+ `Secure` when `cookieSecure`; no Max-Age when `rememberMe` is false). Parse: find the name (accept both the `__Secure-` and bare forms), split at the LAST `.`, recompute and `timingSafeEqual`; invalid -> absent. Clear: same name, empty value, `Max-Age=0`.
- Sign-in limiter: `Map<ip, number[]>` of failure timestamps within 15 min; 10 or more -> 429 `{code:'TOO_MANY_REQUESTS'}` before scrypt runs; success clears the ip. Bounded: on every insert prune entries whose newest timestamp is older than 15 min, and cap the map at 10000 ips (drop the oldest) so a scan against a public `api.<domain>` cannot grow it without bound. `ip = req.ip` (trustProxy honours the edge's `X-Forwarded-For`). Shared with `/auth/login`.

### 3. Guard (`src/auth.ts`, server mode only)

`app.addHook('onRequest', guard)`:
1. `path = req.url.split('?')[0]`.
2. Public when: `path === '/healthz'`; `path.startsWith('/api/auth/')`; `path.startsWith('/auth/')`; `req.method === 'GET' && (path === '/templates' || path.startsWith('/templates/'))`; or `req.method === 'GET' && !isApiPath(path)` (static assets and the SPA shell). `isApiPath` reads `API_PREFIXES` (scaffold): today's list plus WP1's `/api`, `/auth`, `/tls` and WP5's `/templates`, `/template-deployments`.
3. Otherwise resolve the actor (4); null -> 401 `{error:'unauthorized'}` + `WWW-Authenticate: Bearer realm="insta-oss"`.
4. CSRF belt (decision 59): for `actor.source === 'cookie'` and method not in `GET|HEAD|OPTIONS`: when `Origin` (or, failing that, `Referer`) is PRESENT and its host differs from `req.headers.host` -> 403 `{error:'cross-site request rejected'}`; when `Sec-Fetch-Site` is present and equals `cross-site` -> 403; when neither `Origin`, `Referer` nor `Sec-Fetch-Site` is present -> allow (a non-browser client: curl in the headless setup recipe and the server e2e, 08 §1.3 and §7.3). This mirrors Better Auth's allow-list on a presented Origin (platform betterauth.ts `trustedOrigins`), which never requires the header. Bearer requests skip this.
5. `req.actor = { userId, via, scopes, source }`.

### 4. Actor resolution (shared by the guard, `/me`, `get-session`, `/auth/refresh`)

a. `Authorization: Bearer <t>`: empty -> null; `t.startsWith('insta_')` -> `verifyToken` (a failing `insta_` key must NOT fall through to session lookup); else `findSession(t)` -> `{via:'jwt', source:'bearer'}`.
b. No bearer -> cookie -> `findSession` -> `{via:'jwt', source:'cookie'}`.
c. Any actor requires `identity.admin` present and `admin.id === userId`; otherwise null (covers `--reset-admin`).

### 5. Route handlers (server mode)

- `POST /api/auth/sign-up/email`: validate -> 400 with Better Auth codes; admin exists -> 422 `{code:'USER_ALREADY_EXISTS', message:'an admin already exists on this daemon; sign in instead'}`; else create + session; `Set-Cookie`; 200 `{token, user: betterAuthUser(admin)}`.
- `POST /api/auth/sign-in/email`: limiter; admin null or email mismatch -> `verifyPassword(pw, DUMMY_HASH)` then 401 `{code:'INVALID_EMAIL_OR_PASSWORD', message:'Invalid email or password'}`; wrong password -> record failure -> 401; success -> clear, mint session (`rememberMe` default true), `Set-Cookie`, header `set-auth-token: <token>`, 200 `{redirect:false, token, user}` (omit `url`).
- `GET /api/auth/get-session`: actor restricted to `via 'jwt'`; none -> `reply.type('application/json').send('null')`; else `{session: sessionOut(row, presentedToken), user}`.
- `POST /api/auth/sign-out`: revoke if resolvable; always clear cookie; `{success:true}`.
- `POST /api/auth/device/code`: 501 `{error:'device and OAuth login are cloud-only; use insta login --api-key or --email'}`.
- `POST /auth/login`: same checks as sign-in; errors map to `{error:'invalid email'}` 400 / `{error:'invalid credentials'}` 401 (the cloud's text, auth/service.ts:164; the CLI prints it verbatim) / `{error:'too many attempts'}` 429; success -> mint session, NO cookie, 200 `{accessToken: token, refreshToken: token, expiresIn: floor((expiresAt - now)/1000), user: publicUser(admin)}`. The guard's 401 on every other route stays `{error:'unauthorized'}`.
- `POST /auth/refresh`: `{refreshToken}` -> `findSession` (an `insta_` key -> 401) -> 200 AuthResult with the SAME token; else 401.
- `POST /auth/logout`: revoke `body.refreshToken` if it resolves; 200 `{ok:true}`.
- `POST /auth/signup`: 501 `{error:'email-verification signup is cloud-only; create the admin at <consoleUrl>/setup'}`.
- `GET /me`: `{user: publicUser(admin), via}`; `publicUser = {id, email, name, avatarUrl: null, emailVerified: true}`.
- `GET /tokens` -> `{tokens: rows.map(apiTokenOut)}`; `POST /tokens` -> 201 `{token, record}`; body `orgId` must be undefined or null else 400 `{error:'orgId must be omitted on a single-tenant daemon'}`; `DELETE /tokens/:tokenId` -> `{ok:true}` or 404 `{error:'token not found'}`.

Local mode: `registerAuth` registers exactly today's `/me` and the three `/tokens` 501s with today's text.

### 6. SPA shell injection (`server.ts` region A)

`fastifyStatic({ root: cfg.uiDist, wildcard: false, index: false })`; `shellHtml` read once; `sendShell(reply)` replaces `</head>` with `<script>window.__INSTA_OSS__=${json}</script></head>` where `json = JSON.stringify({ mode, setupRequired: cfg.auth.enabled && !loadState().identity?.admin, apiUrl, consoleUrl }).replace(/</g, '\\u003c')`. `GET /` -> shell; not-found handler: `GET && !isApiPath` -> shell, else 404 JSON. The no-build placeholder (line 681) unchanged.

### 7. state.json discipline (`src/state.ts`)

- `saveState(s, { audit } = {})`: `tmp = `${p}.tmp-${pid}-${++seq}``; write; `renameSync(tmp, p)`; before serialising bump `s.rev` (routing class, default) OR `s.auditRev` (`audit: true`); trim `s.events` to the newest `EVENTS_CAP` (5000) rows; update the parse cache and the cached `rev`; call every `onSave(cb)` subscriber with `(s, kind)`.
- `mutate(fn, opts)`: throw `mutate() callbacks must be synchronous: read state, decide, write; await outside` when `fn` returns a thenable; passes `opts` to `saveState`. Audit-class callers: `engine.emit`, `touchLater`'s flush, the scheduler's `markSlept` (decision 54).
- `stateRev()`: `statSync` the file (same key as `loadState`); cache hit -> the cached `rev` number; miss -> parse and cache. Never clones. The router keys its table cache on it and stores `desiredState` on each `Route`, so a proxied request or TCP connection touches no clone of state.json.
- `loadState`: `statSync` key `{mtimeMs, size}`; cache hit -> `structuredClone`; miss -> parse, spread over `EMPTY`, apply `migrateState`, cache.
- `acquireLock(dataDir)`: `openSync(instad.lock, 'wx')` with `{pid, bootId, startedAt, host}`; on `EEXIST`: mtime older than 60 s -> unlink and retry once; mtime fresh -> wait 2 s and retry, for up to 60 s total (the previous container was SIGKILLed and its heartbeat is still under 60 s old), then throw `another instad (pid <pid>, started <startedAt>) holds <dataDir>; stop it or point INSTA_OSS_DATA_DIR elsewhere`; heartbeat `utimesSync` every 20 s (unref). `releaseLock`: clear interval, flush `touchLater`, unlink only if the file still carries our `bootId`.
- `touchLater(fn)`: buffer; one unref'd 30 s interval runs `mutate((s) => { for (const f of buffer) f(s); buffer.length = 0 }, { audit: true })`; `releaseLock` flushes synchronously. Callbacks look rows up by id (no captured references).

### 8. `instad --reset-admin`

Refuse in local mode; `initStatePath`; `acquireLock(cfg.dataDir)` exactly like a boot (a second process mutating state.json under a running daemon would be overwritten by the daemon's next stat-cached `mutate` or `touchLater` flush, or the daemon would keep serving the deleted admin until its cache noticed); when the lock is held exit 1 with `stop the daemon first (docker compose stop instad) then re-run`; `mutate`: no admin -> print `no admin exists`, exit 0; else `previousAdminId = admin.id`, `admin = null`, `sessions = []`, tokens untouched; print `admin removed; open <consoleUrl>/setup to create a new one (existing insta_ tokens keep working once it exists)`; `releaseLock()`. Documented invocation: `cd /etc/instacloud && docker compose stop instad && docker compose run --rm instad --reset-admin && docker compose start instad`.

## Tests

`test/identity.test.ts` (no Docker):
- `hashPassword/verifyPassword round trip; wrong password false; DUMMY_HASH path returns false without throwing`
- `mintToken produces /^insta_[A-Za-z]{64}$/ and verifyToken finds it by hash`
- `verifyToken rejects revoked, expired and malformed keys without a hash lookup for malformed`
- `sessions: mint, find, sliding update after 24h (updatedAt moves, expiresAt extends), expiry at 7d, revoke`
- `cookie: name has __Secure- prefix under https, value is token.hmac URL-encoded, tampered signature reads as absent`
- `sign-in limiter: 10 failures within 15 min block the 11th before scrypt; success resets`

`test/server-auth.test.ts` (fake adapters, `buildServer(makeEngine(serverConfig()), serverConfig())`):
- `401 sweep: every route from app.printRoutes({commonPrefix:false}) outside the allowlist answers 401 {error:'unauthorized'} with WWW-Authenticate` (the integrator reruns this after every merge)
- `sign-up creates the admin: 200 {token,user} + Set-Cookie; second sign-up 422 USER_ALREADY_EXISTS`
- `sign-in: wrong password 401 INVALID_EMAIL_OR_PASSWORD; right password 200 {redirect:false,token,user} + set-auth-token`
- `get-session: with cookie / with bearer -> {session,user}; with nothing -> body null; with an insta_ key -> null`
- `sign-out clears the cookie and invalidates the token`
- `/me: {user: PublicUser, via:'jwt'} with a session; via:'api' with an insta_ key; PublicUser has avatarUrl null and emailVerified true`
- `/tokens: POST 201 {token, record} newest first on GET; DELETE {ok:true}; second DELETE 404; expired token 401; revoked token 401; orgId 'x' 400; expiresInDays 30 sets expiresAt about 30 days out`
- `/auth/login returns AuthResult with accessToken === refreshToken and expiresIn > 0; /auth/refresh with the session token returns the same token; with an insta_ key 401; /auth/logout {ok:true} always`
- `cookie-authenticated POST with a foreign Origin -> 403; same Origin passes; cookie POST with NO Origin, Referer or Sec-Fetch-Site passes (curl); Sec-Fetch-Site: cross-site -> 403; bearer ignores Origin`
- `/auth/login wrong password -> 401 {error:'invalid credentials'}; unknown email -> 401 same text; malformed email -> 400 {error:'invalid email'}`
- `GET / shell contains window.__INSTA_OSS__ with setupRequired true, then false after sign-up`
- `resetAdmin(): sign-up works again and an old insta_ token still verifies against the new admin`
- `/auth/signup and /api/auth/device/code answer 501 with the documented messages`
- `GET /templates and GET /templates/:code need no credentials in server mode` (added when WP5 lands; until then the test asserts the allowlist function directly)

`test/server.test.ts` region WP1 (local mode):
- `local /me is exactly {user:{id:'local',email:null,name:'local'}} (no via)`
- `local /tokens GET/POST/DELETE still 501` (existing assertions at lines 207-208 and 224 keep passing)
- `loadConfig({}) defaults: mode local, listenHost 127.0.0.1, port 8080, domain localhost, auth disabled; server mode without INSTA_OSS_DOMAIN throws; INSTA_OSS_PORT beats --port beats 8080` (may live in `test/config.test.ts`)

`test/state-lock.test.ts` (no Docker):
- `mutate rejects an async callback`
- `saveState leaves no partial file and bumps rev; mutate(fn, {audit:true}) bumps auditRev and leaves rev unchanged`
- `stateRev() returns the current rev without cloning (spy on structuredClone) and tracks an external file change; events are capped at EVENTS_CAP (insert 5010, read 5000 newest)`
- `onSave subscribers fire with kind 'routing' or 'audit'`
- `acquireLock twice in one process throws; a lock with a stale heartbeat is taken over; a fresh lock is retried and taken over once its heartbeat stops (fake timers); a fresh lock whose heartbeat keeps ticking refuses after 60 s with the holder's pid`
- `resetAdmin refuses while the lock is held and prints the stop-the-daemon hint`
- `touchLater flushes on releaseLock`
- `loadState parse cache returns a clone and invalidates when the file changes`

## Done when

- [ ] `npm test`, `npm run typecheck`, `npm run lint` green; `test/server.test.ts` passes with no assertion changed outside region WP1.
- [ ] Server mode boots with `INSTA_OSS_MODE=server INSTA_OSS_DOMAIN=x.test INSTA_OSS_DATA_DIR=$tmp` (fake or real docker): `curl /healthz` 200, `curl /me` 401, sign-up via curl, `/me` with the cookie 200, a second daemon on the same data dir exits with the lock message.
- [ ] `insta login --api-key <k> --api-url http://127.0.0.1:8080` succeeds against a server-mode daemon (CLI `applyApiKeyLogin` hits `/me`); `insta login --email` succeeds via `/auth/login`.
- [ ] Local mode output of `npm run dev` keeps today's three lines verbatim. WP4 adds a data-dir capabilities line ABOVE them (`data dir <path> reflink=<yes|no> engine=<...> mode=local`, plan 04) and on a box with no `/proc/meminfo` and no `INSTA_OSS_MEM_BUDGET_MB` the scheduler's boot reconcile adds one warning below them, so the assembled banner is four lines. Contract decision 12 pins auth, bind, port and the CLI flow for local mode, not the banner.
- [ ] Docs facts handed to WP8 (below).

## Docs facts for WP8

- Setup URL `https://console.<domain>/setup`; one admin; password stored with scrypt; a lost password is recovered on the box with the daemon STOPPED: `cd /etc/instacloud && docker compose stop instad && docker compose run --rm instad --reset-admin && docker compose start instad` (the command refuses while a daemon holds the lock).
- Headless setup needs no Origin header: `curl -c jar -X POST .../api/auth/sign-up/email` then `curl -b jar -X POST .../tokens` work as-is; only a browser-shaped request with a foreign Origin is rejected.
- `events` keeps the newest 5000 rows (COMPATIBILITY note).
- CLI: `insta login --api-key <insta_...> --api-url https://api.<domain>` (verified against `GET /me`); `insta login --email` works; bare/`--device`/`--oauth` answer 501.
- Sessions: httpOnly cookie, 7 days sliding; `insta_` tokens never expire unless `expiresInDays` is given; scopes are recorded, not enforced.
- Every route except `/healthz`, `/api/auth/*`, `/auth/*`, `GET /templates*`, static files and the SPA shell needs a session or bearer in server mode. Local mode has no login.
- Env keys: `INSTA_OSS_MODE`, `INSTA_OSS_DOMAIN`, `INSTA_OSS_DATA_DIR`, `INSTA_OSS_SECRET` (auto-generated into `<dataDir>/secret`), `INSTA_OSS_SESSION_TTL_SEC`, `INSTA_OSS_TRUST_PROXY`.
- Two daemons never share a data dir (`instad.lock`).
