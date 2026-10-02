# Supabase

Postgres backend with auth, storage, realtime and a dashboard.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/supabase)

**Studio, the dashboard, has full access to your database, and the password you set at deploy is
the only thing guarding it.** Pick a strong one.

## Overview

[Supabase](https://github.com/supabase/supabase) is an open-source backend built on Postgres: user
sign-up and sign-in, an auto-generated REST API over your tables with row level security, file
storage with on-the-fly image resizing, realtime messaging over websockets, and Studio, a dashboard
with a table editor and a SQL editor.

This template is upstream's self-hosted stack at tag `self-hosted/v0.8.2`, with every component
image pinned to that tag's `docker/docker-compose.yml`. Instead of one machine running the compose
file, each component gets its own service, and the database is a managed InstaCloud Postgres:

| Service | Runs | Image | Always on |
|---|---|---|---|
| `gateway` | Envoy, with upstream's routes, API key checks and Studio's basic auth. **The one URL you use** | this template's image | yes |
| `auth` | GoTrue (Supabase Auth) | `supabase/gotrue:v2.196.0` | no |
| `rest` | PostgREST | this template's image | no |
| `realtime` | Supabase Realtime | this template's image | yes |
| `storage` | Storage API and imgproxy, on one volume | this template's image | no |
| `studio` | Studio and postgres-meta | this template's image | no |
| `db` | Managed Postgres 16 | platform managed | platform managed |

The template's own image only puts upstream's binaries side by side (Envoy, PostgREST, the Realtime
release, Studio, postgres-meta, the Storage API and imgproxy) and adds an entrypoint that picks one
component per machine. Nothing is rebuilt from source. `auth` runs upstream's GoTrue image
unchanged, with a start command that builds its database URL.

Two pairs share a machine on purpose. postgres-meta has no authentication, so it runs next to Studio
and listens on loopback only. imgproxy has none either, and reads the stored files straight off the
storage volume, so it runs next to the Storage API, also on loopback. Studio's own machine refuses
every request that did not come through the gateway, so the gateway's basic auth cannot be skipped.

## What you get by hosting it

- One HTTPS URL, the gateway's, for everything: `/auth/v1`, `/rest/v1`, `/storage/v1`,
  `/realtime/v1`, `/graphql/v1`, and Studio at `/`. It is the URL you give `@supabase/supabase-js`.
- Your data in a managed Postgres that the platform runs, rather than a database
  container inside the stack.
- Studio behind HTTP basic auth with the username and password you choose at deploy.
- The schema Supabase expects, created on first boot from upstream's own `supabase/postgres`
  migrations at the tag the compose file pins (`17.6.1.136`).
- An anon key and a service role key, signed with a JWT secret generated at deploy. Studio shows
  both under **Project Settings > API Keys**, on the **Legacy anon, service_role API keys** tab.
- Uploaded files on a persistent volume, and image transformations through imgproxy.
- Email sign-up that works without SMTP: new users are confirmed automatically.

## What you need before deploying

A username and a password for Studio. There is no default and nothing is generated: the deploy form
starts with both fields empty. A password the platform minted would be one it could never show you
again, because a template variable is stored write-only.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | Username for Studio's basic auth on the gateway. You choose it, using letters, digits and `.` `_` `@` `-` only. Any other character stops the gateway from starting, with the reason in its logs. |
| `ADMIN_PASSWORD` | yes | Password for Studio. You choose it. |

Generated at deploy and shared by the services that need them, never shown back by the platform:
the JWT secret every component signs or checks tokens with, the token the gateway attaches for
Studio's machine, and Realtime's own secrets. You do not need to read any of them. The anon and
service role keys are derived from the JWT secret on every boot, so every service agrees on them.

Every Supabase login role (`authenticator`, `supabase_auth_admin`, `supabase_storage_admin`,
`supabase_admin`, `supabase_read_only_user`) gets the managed database's own password, the way
upstream gives them all `POSTGRES_PASSWORD`.

To change a setting upstream exposes as an environment variable, set it on the service it belongs
to and restart that service. Common ones:

- SMTP for real confirmation and recovery mail: `GOTRUE_SMTP_HOST`, `GOTRUE_SMTP_PORT`,
  `GOTRUE_SMTP_USER`, `GOTRUE_SMTP_PASS`, `GOTRUE_SMTP_ADMIN_EMAIL` and `GOTRUE_SMTP_SENDER_NAME` on
  `auth`. Then set `GOTRUE_MAILER_AUTOCONFIRM` to `false`.
- Your app's URL for redirects: `GOTRUE_SITE_URL` and `GOTRUE_URI_ALLOW_LIST` on `auth`.
- Closing sign-up: `GOTRUE_DISABLE_SIGNUP` set to `true` on `auth`.
- Studio's AI assistant: `OPENAI_API_KEY` on `studio`.

## After deploy

1. Open the gateway's URL. The browser asks for the username and password you deployed with, and
   Studio opens.
2. Copy the keys from **Project Settings > API Keys > Legacy anon, service_role API keys**: `anon`
   for your app, `service_role` for servers only. The other tab, for publishable and secret keys,
   is empty on purpose.
3. Point the client at the gateway:

   ```js
   import { createClient } from '@supabase/supabase-js'
   const supabase = createClient('https://<gateway-url>', '<anon key>')
   ```

4. Create a table in Studio's table editor or SQL editor, enable row level security on it, and add
   a policy. `supabase.auth.signUp`, `supabase.from('<table>')`, `supabase.storage` and
   `supabase.channel(...)` broadcast then work as on Supabase's own platform.
5. To connect to the database directly, use the `db` service's connection string from the console.
   The console's **Database > Extensions** tab lists only the extensions turned on from that tab, so
   the ones Supabase created over SQL (`pgcrypto`, `uuid-ossp`, `pg_graphql` and the rest) show as
   off there. Studio's own Extensions page shows the real state. Turning one on in the console is
   harmless, but turning it off afterwards runs `DROP EXTENSION`, which for `pg_graphql` turns
   GraphQL off.

## Known limitations

- **GraphQL (`/graphql/v1`) is off.** The managed Postgres does not ship `pg_graphql` yet, and
  requests answer `pg_graphql extension is not enabled`. The template tries
  `create extension pg_graphql` on every boot of `rest`, `realtime`, `storage` and `studio` until it
  succeeds. A deploy made after the database offers it gets GraphQL on first boot. An earlier
  deploy keeps its database running on the old image, so restart the database from the platform
  (`insta postgres restart`, or `POST /projects/{id}/database/restart`) and then restart `rest`.
- **Realtime `postgres_changes` does not deliver yet.** It needs logical decoding with the
  `wal2json` output plugin, which the managed Postgres does not ship yet. A subscription still
  answers "Subscribed to PostgreSQL", but no change ever arrives. Broadcast works. The template
  already sets `wal_level = logical` at boot, like upstream's own database, but Postgres only reads
  it at start. Once the database offers `wal2json`:
  1. restart the database from the platform (`insta postgres restart`, or
     `POST /projects/{id}/database/restart`), then restart `realtime`,
  2. add your tables to the `supabase_realtime` publication, for example
     `alter publication supabase_realtime add table public.messages;`.
- **No Edge Functions and no Supavisor.** The functions runtime is not part of this template, and
  the managed database brings its own connection pooler.
- **Logs and analytics in Studio are off**, since Logflare and Vector are not part of the stack.
- **The new `sb_publishable_` and `sb_secret_` keys are not configured.** Use the legacy anon and
  service role keys, which every Supabase SDK accepts.
- **Six compute services, billed on actual usage.** `gateway` and `realtime` are always on.
  `auth` and `studio` idle-stop and wake on the next request: measured, the first sign-in after
  `auth` slept took about 3 seconds, and the first Studio page about 6. `rest` and `storage` may
  idle-stop too, but their own steady background traffic (about 100 to 200 bytes a second,
  measured) counts as activity, so in practice they stay up.
- **The other services have their own URLs as well.** `auth`, `rest`, `realtime` and `storage` each
  check JWTs themselves, so reaching one directly grants nothing the public anon key does not.
  `studio` refuses any request that did not come through the gateway.
- **Right after `realtime` restarts**, a client's first websocket attempt can fail while it boots.
  The Supabase SDKs reconnect on their own.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. Every upstream image is a two-architecture index,
  and this template's image only copies their files together.
- Self-hosting documentation: <https://supabase.com/docs/guides/self-hosting/docker>
- Upstream: <https://github.com/supabase/supabase>, tag `self-hosted/v0.8.2`
- Images: `supabase/studio:2026.09.07-sha-7996410`, `supabase/gotrue:v2.196.0`,
  `postgrest/postgrest:v14.17`, `supabase/realtime:v2.134.10`, `supabase/storage-api:v1.74.0`,
  `darthsim/imgproxy:v3.31.4`, `supabase/postgres-meta:v0.99.0`, `envoyproxy/envoy:v1.39.1`
- License: Apache-2.0 (upstream `supabase/supabase`).
