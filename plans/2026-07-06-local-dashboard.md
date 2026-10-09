# insta-oss — Local Dashboard Plan (Phase 6)

> **Dated design archive (2026-07-06).** This records the plan as designed at the time.
> Checkboxes and counts are not kept up to date as work ships (the dashboard has since
> shipped and grown past this plan). Read it for the *why*; read the README and code for
> current state.

> **For agentic workers:** execute phases top-to-bottom with superpowers:executing-plans; each phase is independently shippable. Steps use `- [ ]`.

**Goal:** a local web dashboard served by `instad` itself — open `http://127.0.0.1:8080` in a browser and manage projects, branches, services, logs, and governance visually. Design of record is the product mock (2026-07-06): Railway-style two-pane layout — left sidebar with project-level and branch-scoped sections, main pane per page.

**Why OSS goes first:** the cloud `dashboard/` submodule is empty today. Building the UI here as presentational components + a thin same-origin API client means the cloud shell can later wrap the same components (`insta-ui` extraction) with auth/org context — same endpoints on both sides, per the shared-surface doctrine.

---

## Design of record (the mock, adapted local)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ⚡ local ▾ / <project> ▾ / <branch> ▾ / <Page>          ● daemon · Docs │
├───────────────┬──────────────────────────────────────────────────────────┤
│ ◫ Usage       │  Service                                        [+ Add]  │
│ ⑂ Branches    │                                                          │
│ ⚖ Approvals ❷ │  Service        Status     Endpoint            Updated   │
│ ─ Branch ──── │  ┌────────────────────────────────────────────────────┐  │
│ ⑂ main  ⌈prod⌋│  │ 🐘 Postgres   ● Online   io-<ref>-pg (5432)  5m ago│  │
│ ▸ Service     │  │ 🪣 Storage    ● Online   io-minio (9000)     5m ago│  │
│ ≡ Logs        │  │ 📦 default    ● Online   localhost:3000      2m ago│  │
│               │  └────────────────────────────────────────────────────┘  │
│ ⚙ Settings    │                                                          │
└───────────────┴──────────────────────────────────────────────────────────┘
```

Mock → local adaptations (everything else is kept as-drawn):

| Mock (cloud)              | insta-oss                                                        |
| ------------------------- | ---------------------------------------------------------------- |
| `Personal Org` crumb      | fixed `local` org (builtin single tenant)                        |
| `Region: US West 🇺🇸`      | **Endpoint** column — container name + port / `localhost:<port>` |
| `Production` chip         | chip on the default branch (`main`)                              |
| `Text Us` / `Install`     | daemon health dot + Docs link                                    |
| Usage = billing dimensions| Usage = live docker stats (CPU %, memory) — no fake billing      |
| Redis row                 | n/a (fixed postgres+storage pair + compute groups)               |
| `+ Add`                   | add **compute group** dialog; postgres/storage add disabled with "one per project locally" note |

Extra page the mock doesn't have but OSS must: **Approvals** (sidebar badge with pending count) — governance is the differentiator; a pending 202 should be one click to grant/deny, with an "always allow" checkbox (= `approve --always`).

## Architecture

- `ui/` folder in this repo: **Vite + React + TS + Tailwind** SPA. No SSR, no router framework beyond `react-router`.
- `npm run build` → `ui/dist`; `instad` serves it with `@fastify/static` at `/` (API routes keep precedence; SPA fallback for non-API GETs). Same origin ⇒ no CORS, no auth — localhost trust, exactly like the API.
- Dev loop: `vite dev` proxying `/projects|/orgs|/me` → `127.0.0.1:8080`.
- Components stay presentational (props in, callbacks out) + one `api.ts` client (fetch, 202-aware) — the future `insta-ui` seam. Every mutation helper surfaces `{status:'approval_required'}` as a typed result, so any page can pop the approval modal.
- State: plain fetch + `useSWR`-style polling (5s) — the daemon is local; no websockets needed for v1.

## Phase 0 — serving skeleton ✅ (shipped 2026-07-06)

- [x] `ui/` scaffold (Vite React-TS + Tailwind), `ui/dist` gitignored; root `npm run build:ui` script.
- [x] `instad` serves `ui/dist` when present (`@fastify/static`, SPA fallback; `GET /` without a build → helpful "run npm run build:ui" page). Contract test: API routes still win.
- [x] App shell: top bar (org/project/branch/page breadcrumb from live data, daemon health dot), sidebar (sections + active states per mock), routing `/p/:project/:branch/<page>`.
- [x] Project switcher + branch picker dropdowns (from `GET /orgs/local/projects`, `GET /projects/:id/branches`); default-branch chip.

## Phase 1 — Service page (the mock's page) + Branches ✅ (shipped, live-verified vs the mock)

- [x] Daemon: extend `GET /projects/:id/services` items with `status` from `docker inspect` (running → `online`, exited → `stopped`, absent → `not deployed`), `endpoint` (container name + port, or `localhost:<hostPort>` for compute), `updated_at` (from state; add timestamps on deploy/provision writes). Contract tests.
- [x] Service table per mock: icon, name, status dot, endpoint, relative `updated`; per-branch (compute rows follow the selected branch; postgres row = that branch's container).
- [x] `+ Add` dialog → `POST /projects/:id/services` (compute groups); postgres/storage disabled with the local-fixed-pair note; remove with confirm (202-aware: `service.remove` gate).
- [x] Branches page: table (name, default chip, clone-of lineage, created, app count) + create-from dialog + delete (202-aware `branch.delete`).

## Phase 2 — Logs + Usage (needs the docker-backed observability endpoints)

- [ ] Implement roadmap Phase 2 endpoints first: `GET /projects/:id/logs?component=compute|db[&group=][&branch=]` (docker logs --tail, platform LogsResult shape) and `GET /projects/:id/metrics` (docker stats, series shape). Contract tests with fake docker.
- [ ] Logs page: branch-scoped, component/group selector, tail view with auto-refresh + pause.
- [ ] Usage page: live CPU % + memory per container of the project (all branches), sparkline per series; copy states clearly "local telemetry — no billing in insta-oss".

## Phase 3 — Governance surfaces ✅ (shipped early — endpoints already existed; 202→grant→retry loop click-tested)

- [x] Approvals page: pending list (action, requested_at) with Grant / Grant always / Deny; sidebar badge = pending count (poll).
- [x] Settings page: policy matrix (7 gated actions × allow/approve/deny selects → `PUT /policy/:action`), daemon info card (version, port, state path), events timeline (reuse `GET /events`).
- [x] Approval modal wired into every 202-returning mutation (deploy/delete/service/secret writes) — retry-after-grant UX matching the CLI's one-shot grant semantics.

## Phase 4 — polish & release

- [ ] Visual pass against the mock (spacing, light theme, green status, table cards); empty states (no projects → point at `insta project create`; no services → `+ Add`).
- [ ] Error toasts for 4xx/5xx with the daemon's error strings verbatim.
- [ ] README: dashboard section with screenshot; roadmap Phase 6 checked off.
- [ ] One Playwright smoke test: create project via API → page renders the service rows.

## Non-goals (v1)

- No auth/multi-user (localhost trust, like the API).
- No deploy-from-UI (deploys stay in CLI/agent land; the UI observes and governs).
- No secrets values display — names only, values stay behind `insta secrets` (secrets.read gate).
- No cloud shell here — extraction to a shared `insta-ui` package happens when the cloud dashboard starts, not before.
