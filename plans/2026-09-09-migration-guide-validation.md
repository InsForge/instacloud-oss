# Migration guide validation — test record

> **Live record, opened 2026-09-09.** The Render and Railway guides merged as `e1bfc15`
> (insta-oss#98) and the runbook they delegate to merged as `9a4f2d7` (insta-skills#81). Those
> pages hand the reader a prompt and stay deliberately thin, so nearly every claim they make is
> really a claim about the runbook. This file records what was executed against it, so a later
> reader can tell a verified statement from a plausible one.

The matrix and its reasoning are in `insta-cloud/docs/superpowers/plans/2026-09-09-migration-guide-validation-plan.md`.
This is the execution log.

## Why a matrix, not more apps

Case 0 (below) established that the mechanical half of the guide can hold completely while the
migration is still broken: `connect-repo --public` needed no GitHub App, nixpacks built a
Dockerfile-less Django repo, the `DATABASE_URL` binding reached the app, nixpacks ran
`manage.py migrate` unprompted, gunicorn bound the declared port — and the app answered **HTTP 400
to every request**, because its `ALLOWED_HOSTS` came only from `RENDER_EXTERNAL_HOSTNAME`.

Ten more Django apps would have found the same single bug. So each case below is chosen to add at
least one cell no other case covers.

Two rules follow from that run and apply to every case:

1. **"Build succeeded" and "the app serves" are separate verdicts.** The health check is TCP on the
   port (`insta-platform/src/adapters/fly.ts`: `config.checks = { port: { type: 'tcp' } }`), so a
   service refusing every request is indistinguishable from a working one in `insta compute status`.
   Every case ends in a `curl`.
2. **Workers never create projects.** `insta project create` writes the link that
   `findProjectRoot` resolves by walking up, so once `~/.insta/project.json` exists every unlinked
   directory under `$HOME` shares it — two workers collide. Projects are created serially up front
   and each worker is pinned with `INSTA_PROJECT_ID` / `INSTA_ORG_ID`, which `readProject` honours
   ahead of any file.

## Environment

**staging**, agent mode (`insta --agent`), org `441f7efc-fbdd-43b2-bacc-df46892722f7`.

The plan originally specified prod, because staging did not have the agent-governance routes: a
credentialed `POST /agent/sessions` there answered Fastify's `Route POST:/agent/sessions not found`
while `GET /orgs` answered 200. That is no longer true — the same probe now returns
`400 body must have required property 'publicKey'`, so the route is deployed. With the plane the
same on both (`[insta-compute]` in the deploy logs either way), staging costs no production
resources and validates the same surface.

## Cases

| # | project | repo | covers | result |
|---|---|---|---|---|
| 0 | (deleted) | `render-examples/django` | baseline: nixpacks python, compute+pg, http | **done** — see above |
| 1 | `mv1-express` | `render-examples/express-hello-world` | nixpacks **node**; **compute only, zero bindings** | **HTTP 200** |
| 2 | `mv2-gogin` | `render-examples/go-gin-web-server` | nixpacks **go** (compiled); **no `render.yaml` and no Dockerfile** | **HTTP 200** |
| 3 | `mv3-laravel` | `render-examples/php-laravel-docker` | the **Dockerfile lane**; no `render.yaml` | lane holds; app 500s on config |
| 4 | `mv4-celery` | `render-examples/celery` | **portless worker (`port === 0`)**; a **redis** binding; one repo, two compute services | **no route exists** |
| 5 | `mv5-strapi` | `render-examples/strapi-postgres` | a **volume** whose `mountPath` is not `/data`; the older `env: node` spelling | build fails |
| 6 | `mv6-django-data` | `render-examples/django` | **a cutover with data in it** — steps 2 to 5 with something to lose | **HTTP 200, full cutover** |

Every repo's shape was verified against the repo before it was listed, not assumed from its name.

Case 6 exists to stress the two most recent fixes, both of which came out of review rather than
testing: step 1 now stops the service after its verification curl, because `services add` gives a
compute service a default domain and the deploy otherwise leaves a **second writable system** on
the public internet before the restore; and step 4's verification now counts every table exactly,
enumerated from `pg_class`, after `n_live_tup` was shown to report **0 for a fully populated table**
once statistics have been reset. A verification that cannot fail is worthless, so case 6 is asked to
prove the diff catches a deliberate deletion.

## Results

Filled in as each case reports. A case is not "passed" because it deployed: the record for each is
translate / build / boot / serve / bindings / delta.

**Ran on prod.** Staging's build gateway rejects every build for this tenant with
`build gateway POST /builds: 403 token does not match tenant`. Diagnosed read-only: staging is still
two-tier (`api.compute.staging…` for runtime, `control-plane.compute.staging…` for builds) with two
different tokens, and a credentialed probe of `GET /v1/staging/builds/<bogus>` returns **403** with
`INSTA_MICROVM_BUILD_TOKEN` and **404** with `INSTA_MICROVM_TOKEN` — so the build token is simply
wrong and the runtime one would work. Prod has collapsed both onto one host with one token
(**404** either way) and builds fine. Fixing staging is one env change; it was not made here.

### Three migrated and served

| case | build | result |
|---|---|---|
| **1** express (node) | `live` in ~150s | **HTTP 200**, `Hello from Render!` |
| **2** go-gin (compiled) | `live` in 127s | **HTTP 200**, template rendered with its interpolated room id, five static files byte-matching the image, 404 on a missing name |
| **6** django **with data** | `live` in 2m23s | **HTTP 200**, admin rendering `341 users` against 340 migrated rows, login 302, writes landing in the new database and the old one untouched |

Case 6 is the one that matters: 14 tables, 624 rows, a non-`public` schema, two empty tables and
two rows whose first text column begins with the literal `SET transaction_timeout`, from PG 18.6
into prod PG 16.15 — restore `exit 0`, zero `ERROR`s, all 14 `COPY` counts matching, and the
planted hazard rows byte-identical. **First time the app half and the data half ran together.**

### Three failed, and none of them in our lane

| case | where it failed | fix |
|---|---|---|
| **3** laravel | the lane **held** — Dockerfile built, machine ran, HTTP answered. The app 500s | its own `APP_KEY` / config |
| **4** celery | nixpacks detects **no start command** for the repo, so all three of its roles fail identically | a `Procfile` (rescues one role) or a Dockerfile per role directory |
| **5** strapi | detection worked (`yarn run build`), the build ran 4m33s and the build command itself failed | a repo-side Node pin — `render.yaml` asks `~16.13.0`, nixpacks gives 18 |

That distinction is the most reusable thing here: **the blockers were app-side or builder-side, never
lane-side.** The build request carries only `source`, `build` and `target`, with no start-command
field, and the nixpacks type makes only `context_path` configurable — so no choice of build lane can
supply one, and a directory deploy would not have rescued any of the three.

### What the runs changed in the runbook

About twenty corrections, each measured. The ones that would have cost data or a cutover:

- **`--group db` was hardcoded after step 3 tells you to add a *fresh* postgres service.** Following
  the prescription and copy-pasting the rest restores into, verifies and cuts over to the **old
  dirty database** while every check reports success. Step 4 catches it (10 tables against 14), so
  it costs a restore cycle rather than data. Everything is now parameterised on `$PG`.
- **The write-boundary fix addressed the wrong write.** nixpacks bakes `manage.py migrate` into the
  start command, so the schema lands at container start — measured, while status is still
  `deploying`, before the build reports `live` and before the stop. 10 tables, 48 rows.
- **`n_live_tup` cannot carry a data-loss guard**: after `pg_stat_reset()` a 3,000-row table reports
  0, so both sides read 0 and compare equal. Replaced with exact per-table counts enumerated from
  `pg_class`, all schemas.
- **The function check produced 139 rows against 2** without a `pg_depend deptype='e'` exclusion — a
  137-line false-positive diff on every migration, which trains an agent to ignore it.
- **`connect-repo` silently discards the port set at `services add`** (`github.ts` takes the
  detection candidate's), invisible except in `--json`. Certain death for a hardcoded 3000/5000.
- **nixpacks pins the language version from a fixed nixpkgs revision, not the repo** — Go 1.22.1,
  Node 18, Python 3.12.7 — confirmed in three languages, and the likely cause of case 5.
- **The session-recovery instruction logged the whole machine out.** `insta setup agent` without
  `--env` defaults to prod and, per its own help, "switches and persists, like `insta env use`". A
  worker followed it and ended the first attempt at this matrix.

### Honest verdict

Asked whether a reader following the runbook end to end would succeed, case 6's answer was **"a
careful reader: yes, on the second attempt; a literal reader: no, unaided"** — every technically
hard thing in the file was already right, and the one wrong turn was the `--group db` copy-paste,
now fixed. Cases 1, 2 and 6 are three complete migrations; cases 3, 4 and 5 are three repos that
need a change committed to them before any platform can build them.

## Not covered

Heroku, Railway and Fly as sources, since there is no account to migrate *from*. Object storage
contents. Zero-downtime cutover. The per-source host-coupling table in the runbook is read from
each platform's own official example rather than executed, and stays labelled that way.
