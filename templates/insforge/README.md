# InsForge

Open-source backend platform your coding agent can operate.

> **Draft.** It stays out of the catalog while two calls are pending: this registry has no
> category that fits a backend platform (it is filed under `ai-agent`, the closest of the three),
> and the image is amd64 only while both upstream images publish arm64. Neither is a defect in the
> template; both are decisions someone else makes.

## Overview

[InsForge](https://github.com/InsForge/InsForge) is an all-in-one backend platform: PostgreSQL with
a generated REST API, authentication with OAuth providers, file storage, edge functions, an AI
model gateway and a dashboard over all of it. Its point of difference is that a coding agent drives
it directly, through an MCP server or the InsForge CLI, so the agent can read schemas and logs and
then create tables, deploy functions and configure auth itself.

This template packages upstream's own release, pinned to `v2.3.2`. It is not a rewrite and not an
API anyone here wrote: the dashboard, the API surface and the database schema are upstream's.

What the template does add is a single container. Upstream ships a four-service Compose stack
(its Postgres image, PostgREST, a Deno runtime, the Node server) wired together over a private
Docker network, and a template has no such network: `${services.<name>.host}` resolves to the edge
router, which routes HTTP and nothing else. A managed `{ type: postgres }` cannot stand in for
upstream's database either, because that database is not stock — it preloads
`pg_cron, http, pgcrypto, insforge_pg_utils`, and `insforge_pg_utils` is a C extension that exists
only in `ghcr.io/insforge/postgres`. So `./Dockerfile` builds an overlay on that image and
`./entrypoint.sh` supervises all four processes behind the one routed port.

## What you get by hosting it

- A dashboard at your own HTTPS URL, signed into with the admin credentials you set at deploy.
- A PostgreSQL 15 database with upstream's extension set (`pg_cron`, `http`, `pgvector`,
  `postgis`, `timescaledb`, `pg_graphql`, `pg_net`, `insforge_pg_utils`) and a PostgREST data API
  generated from whatever schema you create.
- Auth, file storage on local disk, edge functions on Deno, and the AI gateway, all from the same
  origin, so an app you build against it needs one base URL.
- An MCP endpoint and API keys you mint from the dashboard, which is how a coding agent connects.
- A volume at `/data` holding the Postgres data directory, uploaded files and logs, so all of it
  survives a restart or a redeploy.

## What you need before deploying

- An admin username and password of your choosing. Nothing else.
- Optionally an OpenRouter API key, if you want the AI page's model gateway. Everything else
  (OAuth providers, SMTP, S3-compatible storage, Stripe) is configured in the dashboard after
  deploy rather than as a deploy variable.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | Sign-in name for the dashboard's root account. The sign-in form expects an email address, and any string is accepted. |
| `ADMIN_PASSWORD` | yes | Password for that account. Pick your own: template variables are stored write-only, so the platform cannot show it to you later. |
| `OPENROUTER_API_KEY` | no | Enables the AI page's model gateway. From <https://openrouter.ai/keys>. |
| `INSFORGE_TELEMETRY_DISABLED` | no | Set to `1` to turn off upstream's anonymous usage telemetry. |
| `JWT_SECRET` | generated | Signs the tokens the dashboard, the SDK and PostgREST all verify, and is written to the database as `app.settings.jwt_secret` for RLS policies. |
| `ENCRYPTION_KEY` | generated | Encrypts secrets at rest, including the ones edge functions read back. |
| `POSTGRES_PASSWORD` | generated | The embedded Postgres superuser password, reachable on loopback only. |

Set by the template, not by you: `API_BASE_URL` and `VITE_API_BASE_URL` resolved to the service's
own HTTPS URL (OAuth callbacks, emailed verify and reset links, and the S3-compatible storage
endpoint are all built from them), `PGDATA=/data/postgres`, `STORAGE_DIR=/data/storage` and
`LOGS_DIR=/data/logs` on the volume, and `POSTGRES_DB=insforge`, which upstream's
`postgresql.conf` pins `cron.database_name` to.

The service is always-on. `pg_cron` runs inside the bundled Postgres, the schedules feature exists
to fire jobs nobody requested, and realtime holds websockets open, so an idle stop would take all
three down; and this machine is the database, which is a different risk from stopping a stateless
one.

## After deploy

1. Open your service URL and sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
2. Create a table from the Database page, or let an agent do it: the Connect page hands you the MCP
   configuration and the API keys a coding agent needs.
3. Anything you build against it uses the same URL as its base: `/api/database` for the REST data
   API, `/api/auth` for sign-up and sign-in, `/api/storage` for files, `/api/functions` for edge
   functions.

First boot is slower than later ones: Postgres runs `initdb` and the app applies its full
migration set before the server starts answering, which is the only time that happens.

## Links

- Architectures: `linux/amd64` only. Both upstream images publish `arm64`, but the PostgREST
  release asset pinned here is the `x86-64` static build, and the arm64 leg would compile the whole
  Node monorepo under QEMU. Neither has been done, so the claim is one architecture.
- Upstream: <https://github.com/InsForge/InsForge>, pinned to `v2.3.2`
- Documentation: <https://docs.insforge.dev>
- Database image: `ghcr.io/insforge/postgres:v15.13.4` (upstream's own)
- Also bundled: [PostgREST](https://github.com/PostgREST/postgrest) `v12.2.12` (MIT) and
  [Deno](https://github.com/denoland/deno) `v2.0.6` (MIT), the versions upstream's Compose file
  pins
- License: Apache-2.0 (upstream `InsForge/InsForge`)
