# Self-hosted InsForge migration validation — test record

> **Live record, opened 2026-09-14.** The InsForge guide (`docs/migrate/insforge.mdx`) hands the
> reader a prompt and stays thin, so its claims are claims about the runbook's InsForge section
> (instacloud-skills, `insta/references/migrate.md`). This file records what was executed against a
> real self-hosted InsForge and a real InstaCloud project, so a later reader can tell a verified
> statement from a plausible one.

## Why this source is different

Every other guide moves an app off a platform onto InstaCloud's primitives. Here the source and the
target run the **same software**: InsForge's own backend and PostgREST images, unchanged. That has
two consequences the other guides do not have.

1. **The four secrets travel.** `JWT_SECRET`, `ENCRYPTION_KEY`, `ACCESS_API_KEY` and
   `ACCESS_ANON_KEY` are environment variables in a self-hosted `.env`. Carried over verbatim, every
   user session stays valid, `system.secrets` decrypts, and the app's anon key is unchanged. The app
   changes one line, `baseUrl`.
2. **Only the database is substituted.** A compute service exposes HTTP only, so InsForge's own
   Postgres image (PG 15 plus a C preload hook) cannot be reached by its siblings on compute. The
   managed Postgres 16 stands in for it. Case 0 below measures exactly what that substitution costs.

## Environment

- InstaCloud **staging**, project `insforge-e2e` (`ff0013d2-e7bd-460c-8f3a-b177a62b3552`), branch `main`.
- Target: managed Postgres 16.15; `ghcr.io/insforge/insforge-oss:v2.3.2` on `compute/api` (port 7130,
  always-on, 10 Gi volume); `postgrest/postgrest:v12.2.12` on `compute/postgrest` (port 3000,
  always-on); `storage/files`.
- Source: `deploy/docker-compose/docker-compose.yml` from `InsForge/InsForge` main, run locally with
  Docker 28.3.3, `insforge-oss` pinned to v2.3.2, `ghcr.io/insforge/postgres:v15.13.4`.
- Client tools on the operator machine: `pg_dump`/`psql` 18, `aws` CLI.

## Cases

| # | Case | Adds |
|---|---|---|
| 0 | Capability probe of the managed Postgres against InsForge's `postgresql.conf` and init SQL | whether the substitution is even possible |
| 1 | Stack boots on the managed Postgres from published images | the deploy half |
| 2 | Migration, first pass: `pg_dump --no-owner --no-privileges`, restore into a fresh database | the data half |
| 3 | Migration, second pass: InsForge's own `backup.sh`-style plain dump, plus storage files | the sequence the guide describes |
| 4 | The missing `insforge_pg_utils` hook: what breaks, what closes it | the one functional gap |

## Results

| # | Result | Evidence |
|---|---|---|
| 0 | **Passes every requirement but one.** DSN role is `postgres`, `rolsuper = t`, CREATEROLE; `shared_preload_libraries` includes `pg_cron`; `cron.database_name` is the tenant database; `CREATE EXTENSION` works for `pgcrypto`, `http` 1.7, `pg_cron` 1.6 (`vector` 0.8.6 preinstalled); `CREATE EVENT TRIGGER`, `CREATE ROLE`, `ALTER DATABASE … SET app.encryption_key` and `LISTEN` all succeed. TLS is required from the client (the lane is SNI-routed; `sslmode=disable` lands on the wrong instance). The hook is not installable. | psql transcript, two throwaway projects, deleted |
| 1 | **Boots and serves.** 67 migrations ran on first boot; `GET /` 302 → `/dashboard/login` 200; `GET /api/health` 200 `{"status":"ok","version":"2.3.2"}`; admin login 200; create table 201; insert 201; read through PostgREST 200 with admin, anon key and API key; RLS table anonymous read `[]` 200. | `compute/api` logs, curl codes |
| 2 | **Migrated, with avoidable fix-ups.** Restore had one harmless error (`SET transaction_timeout`, a PG 17 GUC from pg_dump 18). Because the dump dropped owners and privileges, three repairs followed: `UPDATE cron.job SET database = current_database()`, `SELECT system.reassign_public_objects_to_project_admin()`, and re-applying 295 GRANTs from a second dump. After rebinding both services and restarting: 3 migrated rows served, migrated user logs in with the original password, the old database has 0 client connections. | `restore.log`, curl codes on `postgres/db2` |
| 3 | **Migrated with zero restore errors, files included.** `db-init.sql` verbatim: 15 statements, 0 errors. `jwt.sql` verbatim **succeeds against the wrong database** (see below). Plain dump minus the one `transaction_timeout` line: 791 statements, 0 errors, 96 `OWNER TO project_admin` and 282 GRANTs applied because the roles pre-exist. Post-restore: only `UPDATE cron.job` (2 rows). `system.migrations` 67/67. Storage: 5 bindings + 2 flags, `aws s3 sync` of the `storage-data` volume into `s3://$S3_BUCKET/local/`, 2 objects; hosted API lists both buckets, public object anonymous 200 via a 302 to a presigned URL, private object anonymous 401 and authenticated 200, sha256 equal to source, a new upload lands in the InstaCloud bucket. `storage.objects` rows equal objects in the bucket, no path column to rewrite. | `restore4.log`, curl codes on `postgres/db4`, `insta storage list` |
| 4 | **One 403, one line to close it.** Without the hook, RLS and policy behaviour was identical to the hook-equipped local stack. `CREATE EXTENSION` through InsForge's SQL endpoint (runs as `project_admin`) returned `403 permission denied to create extension`. `GRANT CREATE ON DATABASE` fixes trusted extensions only (`tablefunc` yes, `pg_freespacemap` no); `ALTER ROLE project_admin SUPERUSER` fixes all. | paired requests, local vs hosted |

### What the runs changed in the guide and runbook

- **`jwt.sql` must be retargeted.** It says `ALTER DATABASE postgres SET …`. A managed instance has a
  database named `postgres`, so the statement succeeds silently and the tenant database never gets
  the JWT settings. The runbook rewrites it to `current_database()`. This is the only edit to
  InsForge's init SQL.
- **Files before the dump.** Bucket and object metadata live in `storage.buckets` and
  `storage.objects` and ride the dump. The first pass of case 3 dumped before uploading and the
  target listed nothing; the pass was redone into a fresh database.
- **Dump plain, keep owners and privileges.** Case 2's three repairs disappear when the dump is
  taken the way InsForge's `deploy/backup.sh` takes it. The runbook now says so, and drops only the
  `SET transaction_timeout` line when the client is pg_dump 17 or newer.
- **Deploy PostgREST first.** A compute service has no URL until its first deploy, and the backend
  needs `POSTGREST_BASE_URL` at boot. Then deploy the backend, set `API_BASE_URL`, restart.
- **The backend reads `POSTGRES_HOST/PORT/DB/USER/PASSWORD`, not `DATABASE_URL`,** and `pg` needs
  `PGSSLMODE=require` to negotiate TLS. Five secrets split from the DSN in the shell, one flag.
- **Storage names.** `S3_ACCESS_KEY_ID ← AWS_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY ←
  AWS_SECRET_ACCESS_KEY`, `S3_BUCKET ← BUCKET_NAME`, `S3_ENDPOINT_URL ← AWS_ENDPOINT_URL_S3`,
  `S3_REGION ← AWS_REGION`, plus fixed `S3_FORCE_PATH_STYLE=true` and `S3_USE_PRESIGNED_URLS=true`.
  InsForge keys objects as `${APP_KEY:-local}/<bucket>/<key>`, so the sync target is `local/`.
- **`ALTER ROLE project_admin SUPERUSER`** stands in for the hook. The DSN is superuser anyway; the
  hook exists for least privilege on a shared self-hosted box.

### Honest verdict

A self-hosted InsForge migrates onto InstaCloud today with existing primitives, database, users and
files, and the app changes one line. It is not yet one click: the agent runs about twenty-five
commands, and one of them (running InsForge's init SQL against the managed database) has no
platform equivalent. Two follow-ups would shorten it without unblocking anything: discrete
`PGHOST`/`PGPORT`/… credentials on the postgres source, and a template. A compute service that could
expose a TCP port would remove the substitution altogether and let InsForge's own Postgres image
run; it would also admit every other bring-your-own-database image.

## Not covered

- The Deno functions host. `docker compose` mounts `functions/` into a stock Deno image, so there is
  no published image to deploy; `deploy/Dockerfile.deno` would need to be built. `DENO_RUNTIME_URL`
  was a placeholder throughout.
- A custom domain on the backend, InsForge Cloud as a source, production, more than one replica
  (local-disk `STORAGE_DIR` would not survive it; the S3 path would), email and payment providers,
  realtime through the PostgREST channel, branching an InsForge project.
- PostgREST is reachable on a public URL here, JWT-gated with `anon` as the fallback role. That is
  Supabase's posture, not InsForge's compose default.

## Follow-ups this surfaced

- **Platform:** discrete PG credentials on a postgres source; a TCP endpoint for compute services;
  private service-to-service networking (fly-parity 2.4) so PostgREST need not be public.
- **InsForge:** read `DATABASE_URL` (with `sslmode`) at runtime; make `jwt.sql` database-name
  agnostic and the init SQL idempotent and operator-runnable; publish a functions-host image; a
  documented hook-less mode; a "restore into a managed Postgres" note (roles first,
  `cron.database_name`).

## State left behind

Kept for inspection, delete when done: project `insforge-e2e` with `postgres/db`, `postgres/db2`
(idle), `postgres/db4` (live), `compute/api`, `compute/postgrest`, `storage/files`. `postgres/db3`
was deleted the same day because its DSN was echoed into a local transcript. Local: the
`insforge-e2e-src-*` compose stack and its volumes.
