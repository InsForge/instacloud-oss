# 07 WP7: dashboard (`ui/`)

Contract: `00-contract.md` sections 8 (decision), 9 (every route the UI calls), 10, 11, 13 (view mapping), decisions 25, 29, 31, 40. Design source: `designs/wp7.json`, adjusted to: setup via `/api/auth/*` (not `/auth/signup`), mode and setup flags from `window.__INSTA_OSS__` (not from a `/me` 401 body), Domains hidden by mode (not by probing 501), `endpoint` stays `host[:port]`, `sleptAt` and always-on live where the contract puts them. Merge position: after WP6; developed in parallel against the fake-adapter daemon and the routes in section 9.

## Scope

Extend the Vite + `@insforge/ui` dashboard into the self-host console: auth gate, Setup page, Login page, Account > API tokens, two-lane Deploy dialog (image, template), Templates gallery, service detail page with Settings (rename, always-on, limits, volume) and Domains, service rows with hostnames, Sleeping state, Wake button and always-on switch, Database page sleeping state. Server-only UI hidden in local mode. Nothing in the dashboard wakes a sleeping service except an explicit Wake, Deploy, Restart or clicking a service URL. All new helpers are pure modules under `ui/src/lib` with vitest tests run from the root config. New runtime dependencies in `ui/package.json` need a stated reason (the Markdown renderer stays hand-written; components come from `@insforge/ui`). Granted since this plan was written: `lucide-react` (the kit's icon set) and the two `@fontsource-variable` packages (Inter and Geist Mono, the console's own typefaces, self-hosted because next/font is Next-only).

## Files

Owned (everything under `ui/`): `ui/src/api.ts`, `ui/src/App.tsx`, `ui/src/hooks.ts`, `ui/src/components/{AuthGate,TokenCreate,Layout,ui,AddServiceDialog,DeployDialog,TemplateDeployForm,DeploymentProgress,Markdown,DomainsSection}.tsx`, `ui/src/pages/{Setup,Login,Tokens,Services,ServiceDetail,Templates,DatabaseInsight,Logs,Environments}.tsx`, `ui/src/lib/{status,templateVars,domains,apiUrl,mode}.ts` and their `*.test.ts`, `ui/vite.config.ts` (API_PREFIXES gains `/auth`, `/api`, `/templates`, `/template-deployments`, `/regions`), `ui/index.html` (`<meta name="color-scheme">`). Root `vitest.config.ts`: `include: ['test/**/*.test.ts', 'ui/src/lib/**/*.test.ts']` (the scaffold's exclude rule stays).

Shared: none. Daemon-side needs are all in section 9 of the contract and owned by WP1/WP2/WP3/WP5; WP7 files an issue against the owner rather than editing `src/`.

## Algorithm

### A. Boot and mode (`lib/mode.ts`, `components/AuthGate.tsx`)

1. `readBoot()`: `window.__INSTA_OSS__ ?? { mode: import.meta.env.VITE_INSTA_MODE ?? 'local', setupRequired: false, apiUrl: location.origin, consoleUrl: location.origin }`.
2. Local mode: no gate; today's flow; Setup, Login, Tokens, the user menu and Domains are never rendered.
3. Server mode: `AuthGate` calls `GET /api/auth/get-session` once. `null` + `setupRequired` -> `Navigate /setup`; `null` -> `Navigate /login?next=<path>` (unless already there); a session -> render children with `{ mode:'server', user }` in context. `api.call` on 401 (outside `/login` and `/setup`) invokes `api.onUnauthorized()` which sets the gate to `login`.
4. `apiUrlForCli(origin)`: replace a leading `console.` label with `api.` keeping protocol and port; else return the origin (local mode). The value is also available as `boot.apiUrl`; prefer `boot.apiUrl` and fall back to the derivation.

### B. Setup page (`/setup`)

Guard: mode server and `setupRequired`, else `Navigate /`. Form: name (optional), email, password (min 8), confirm. Submit `POST /api/auth/sign-up/email {name, email, password}`: 422 -> `An admin already exists. Sign in instead.` with a link to `/login`; 400 -> the Better Auth `message`; 200 -> the cookie is set; `refresh()`; step 2 `TokenCreate` (name default `laptop`) -> `POST /tokens {name}` -> one-time key with `CopyButton` and the exact line `insta login --api-key <token> --api-url <apiUrl>`; `Skip` and `Open dashboard` navigate `/`.

### C. Login page (`/login`)

`POST /api/auth/sign-in/email {email, password}`; 200 -> `refresh()` then navigate `safeNext` (must start with `/` and not `//`); 401 -> `Wrong email or password.`; 429 -> `Too many attempts; try again later.` Enter submits.

### D. Tokens page (`/account/tokens`)

Server mode only. `usePoll(api.tokens, [], 30000)`; rows `!revokedAt` sorted by `createdAt` desc: name, `insta_` + bullets, created (`relTime`), last used or `never`, expires or `never`. Create: name + expiry `Select` (30, 90, 365 days, never) -> `POST /tokens {name, expiresInDays?}` -> reveal panel. Revoke: `ConfirmDialog` -> `DELETE /tokens/:id`; 404 -> `Already revoked.` Sign out (TopBar menu): `POST /api/auth/sign-out` then navigate `/login`.

### E. Services page

1. `services = usePoll(api.services)`, `health = usePoll(api.runtimeHealth)`; interval 2 s while any service is waking, else 5 s. Postgres rows also read `GET /database/instance?branch&group=<name>` (15 s) for the scale-to-zero switch.
2. `deriveStatus(row, h, waking)` (`lib/status.ts`), in order: waking -> `Waking`; no health or `unknown` -> `runtime === 'online'` ? `Online` : unknown; `healthy` -> `Online`; `starting` -> `Starting`; `crashed` -> `Crashed` (title `Not answering on its port; check Logs`); `none` -> `Not deployed`; `standby` -> compute with `desired_state === 'stopped'` -> `Stopped`; `desired_state === 'suspended'` -> `Suspended`; else `Sleeping` (title `Idle; wakes on the next request` for compute, `... connection` for databases). Storage rows show `runtime` only. `wakeable = Sleeping && type === 'compute'`.
3. Wake: `POST .../start?branch=` (compute only, as on the cloud); ok -> `useWaking().wake(sid)`; approval -> `ApprovalPrompt` retry; entries clear when health reports `healthy`/`crashed` or after 60 s.
4. URL column: `HostLink({domain, endpoint, mode})`: shows `domain`; link href = server `https://<domain>`, local `http://<endpoint>`; `CopyButton` copies the href. A sleeping compute link still works (the router wakes it); tooltip says so.
5. Always on: compute and managed rows `Switch checked={!!row.always_on}` -> `PUT .../always-on {enabled}`; postgres rows `Switch checked={!instance.scaleToZero}` -> `PATCH /database/settings?branch&group {scaleToZero: !checked}`; storage none.
6. Kebab: compute Start/Stop/Suspend/Restart/Rename/Remove; managed Rename/Remove; postgres Rename/Remove; storage Make public/private, Rename, Remove. Row click -> `services/<id>`.
7. Header: `Deploy` (primary, `DeployDialog`), `Add Service` (`AddServiceDialog`). Empty state when no services: `No services yet. Add a database or storage, or deploy an app or a template.`
8. Service ids are opaque and branch-scoped (contract decision 49: `GET /services?branch=<b>` returns `<branchId>:<serviceId>` off the default branch and the bare id on it). The UI never parses or compares ids across branches: `useWaking`, health lookups and `services/:sid` links key on `row.id` from the SAME `?branch=` list; every `/services/:sid/*` call keeps sending `?branch=` (the daemon resolves the qualified id first, then the query, so both agree); a branch switch while on `services/:sid` navigates to the list, because that id does not exist on the other branch. React Router accepts the `:` in the path segment.

### F. Service detail (`services/:sid`)

Header: type icon or template logo, name, `StatusCell` with Wake, `HostLink`, template badge. Tabs Overview (image, port, volume, desired state, template code, last update, Restart for compute) and Settings: General (rename -> `POST .../rename`, 409 inline); Sleep (always-on switch as E.5, hint `Never put to sleep when idle. Off: sleeps after the idle window and wakes on the next request or connection.`; a stopped compute adds `Start it to re-enable wake on request.`); Resources (compute/managed: `GET .../limits` -> cpu `Select` over `[1,2,4,6,8]` up to `cap.cpu`, memory input step 256 within the band, caption `This machine: <cap.cpu> vCPU, <cap.memoryMb> MB`, Save -> `PUT .../limits {memoryMb, cpu}`, 400 inline, 202 -> approval; postgres: cpu/memory quantity inputs -> `PATCH /database/settings {cpu, memory}` from `cpuMilli/memoryMib`); Volume (`GET .../volume`; grow via `PUT`; attach when null); Domains (compute only, server mode only, `DomainsSection`); Danger (Remove -> `DELETE .../services/:sid`, gated).

### G. Domains (`components/DomainsSection.tsx`, `lib/domains.ts`)

List `GET /compute/domains?branch&group`. Add: `normalizeHostInput` (lowercase, strip scheme/path/trailing dot) + `HOSTNAME_RE` -> `POST /compute/domain {hostname, branch, group}`; 409 -> body error. Card: hostname, stage badge `domainStage(r)`: `error` when `status === 'error'` or `errorReason`; `active` when `configured && status === 'ready'` (the daemon sends no `ssl` field, decision 25; certificate presence is folded into `configured`); `verifying` when some `dns[].status === 'ok'` and not configured; else `needs-records` (dns statuses are the cloud's `ok | missing | mismatch | unchecked`; `mismatch` shows the record's expected value). Hints per stage; DNS table (type, name, value with `CopyButton`; the `note` line when present). Verify -> `GET /compute/domain?hostname&branch&group`. Remove -> `ConfirmDialog` -> `DELETE`.

### H. Deploy dialog

Tabs Image | Template. Image: image (required), port (default 8080), target `Select` of compute rows plus `New service...` with a name input -> `POST /projects/:id/deploy {image, port, group, branch}`; ok -> close, reload, mark waking; 202 -> approval retry; 400 inline. Template: phase 1 picker over `GET /templates` (client-side search over code/name/tagline/tags, category rail with counts); phase 2 form from `GET /templates/:code` using `lib/templateVars.ts` (`flattenVariables` de-duplicated by name with required OR-ed; `mustFill = required && !generate && default === undefined`; required first, optional collapsed `Optional (N)`; placeholders `generated on deploy` / `default: x`; `isSecretName` -> password input with reveal; `canSubmit`; `payloadVariables` drops blanks); submit `POST /projects/:id/template-deployments {templateCode, branch, variables}`: 202 `approval_required` -> approval retry (gates may chain up to four times); 202 with `deploymentId` -> phase 3; 400 `missing_variables` -> mark fields via `applyMissing`; 409/404 inline. Phase 3 `DeploymentProgress`: poll `GET /template-deployments/:id` every 2 s until `succeeded|failed|partial` or 15 min; four steps with done/active/pending marks; services list with state badges and URL links; `error` and `logsTail` in a `<pre>`; `Close`, `Open service` when exactly one URL. Opened from Templates with a preselected code jumps to phase 2.

### I. Templates gallery (`/p/:projectId/:branch/templates`)

`usePoll(api.templates, [], 60000)`; search + category rail; cards (logo with monogram fallback, name, tagline clamped, category badge, version, license). Card -> `GET /templates/:code` -> detail dialog (header links, services table, variables, README via `components/Markdown.tsx` with raw HTML escaped, footer `Deploy to <branch>` -> DeployDialog). Sidebar item `Templates` after `Service`.

### J. Add Service dialog

Type `Select` (compute default; postgres, storage, redis, mysql, mongodb); name validated `/^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$/`; compute extras: image (optional), port (default 8080), Always on switch (default off, hint `Off: sleeps when idle and wakes on request`), Volume switch + Gi; storage: Public switch. `POST /projects/:id/services {type, name, branch, ...}`; 201 -> close/reload; 202 -> approval; 409 -> `A <type> named <name> already exists.`; 400 -> body error.

### K. Database page sleeping state

The three reads keep their intervals; a 503 whose message matches `/sleeping/i` sets `sleeping`, disables the polls (`usePoll` gains `{ enabled }`), renders `EmptyState` `Postgres is sleeping` with `It wakes on the next connection. Turn on Always on in the service settings to keep it warm.`, buttons `Service settings` (to the first postgres row's detail page) and `Check again`. With several postgres services the page picks the first postgres row; a picker is deferred to #18.

### L. Logs and Environments copy

Logs: muted note when runtime-health says `standby` for the selected component: `Sleeping; showing the last lines before it went to sleep.` Environments: `its own Postgres (data forked at the file level), its own bucket (objects copied), and a redeploy of every app; a new environment starts asleep unless a service is always on.`

### M. Polling invariant

Every periodic read (`/orgs/local/projects`, `/branches`, `/services`, `/runtime-health`, `/approvals`, `/healthz`, `/secrets/tree`, `/operations`, `/events`, `/policy`, `/logs`, `/metrics`, `/database/*`, `/tokens`, `/templates`) is answered from state, docker reads or a 503 sleeping answer; none passes through a router lane, so an open dashboard tab never keeps a service awake.

## Tests

`ui/src/lib/status.test.ts`: every branch of `deriveStatus` (the table in E.2), storage rows, unknown health, waking precedence.
`ui/src/lib/templateVars.test.ts`: flatten/de-dup with required OR; `mustFill` for generate/default; `canSubmit`; `payloadVariables` drops blanks; `applyMissing` reads `name` or `key`; `isSecretName` cases.
`ui/src/lib/domains.test.ts`: `domainStage` for the four stages from envelopes WITHOUT an `ssl` key (active = configured + ready; verifying = a dns ok while not configured; needs-records for missing/unchecked; error); `HOSTNAME_RE` accept/reject; `normalizeHostInput`.
`ui/src/lib/apiUrl.test.ts`: `console.x` -> `api.x` keeps port and protocol; raw IP and localhost unchanged; `cliLoginLine` format.
`ui/src/lib/mode.test.ts`: `readBoot` falls back to local when `window.__INSTA_OSS__` is absent; server flags pass through.

Daemon-side contract tests the dashboard relies on (owned elsewhere, listed so WP7 can point at them): server-auth suite (WP1: sign-up, sign-in, get-session `null`, tokens, shell `__INSTA_OSS__`); services rows `domain`/`endpoint`/`always_on`/`image`/`port`/`template_*` (WP2/WP3/WP5); runtime-health `standby` vs `crashed` (WP3); limits shapes (WP3); templates and template-deployments (WP5); domains routes (WP2); database reads 503 `sleeping` (WP3); SPA fallback for `/setup`, `/login`, `/account/tokens`, `/p/x/main/templates` while `/templates` returns JSON (WP1's `isApiPath`; add the assertion to `test/server.test.ts` region WP1 if missing).

Build gate: `npm run build:ui` (tsc + vite) green.

## Done when

- [ ] `npm run build:ui` green; root `npm test` runs the `ui/src/lib` tests green.
- [ ] Against a local-mode daemon: no Setup/Login/Tokens/Domains anywhere; Services shows Sleeping/Wake and the always-on switch; Deploy dialog deploys an image and a template; Templates gallery lists the bundled catalog.
- [ ] Against a server-mode daemon (integrator, compose stack): first visit lands on `/setup`, creates the admin, mints a token, the printed `insta login` line works; `/login` and sign-out work; the user menu shows the email; Domains section appears on a compute service.
- [ ] Nothing in the dashboard wakes a sleeping service except Wake, Deploy, Restart or clicking a URL (verified by watching `insta events` for `service.wake` while a tab sits open for one idle window).
- [ ] Docs facts handed to WP8.

## Docs facts for WP8

- First visit: `https://console.<domain>/setup`, then `Create a CLI token` prints the exact `insta login --api-key ... --api-url https://api.<domain>` line; later sign-ins at `/login`; Account > API tokens mints and revokes keys.
- Services page: `Sleeping` (compute wakes on the next request via the Wake button or a visit; databases wake on the next connection), `Always on` switch per service (postgres through scale-to-zero), hostnames with copy buttons.
- Service detail: rename, always-on, cpu/memory limits, volume, custom domains (server mode), remove.
- Deploy dialog: image or template; template deploys show the four steps and per-service URLs; up to four approvals when the policy is `approve`.
- Templates gallery reads the bundled catalog; logos are embedded.
- The Database page says `Postgres is sleeping` instead of waking it; management actions wake it.
- The dashboard never keeps a service awake by itself.
