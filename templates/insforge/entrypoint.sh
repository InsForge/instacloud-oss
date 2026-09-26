#!/bin/bash
# Bring up upstream's four-process stack inside one container and keep the Node server in the
# foreground, so the platform's HTTP health gate probes the thing a user actually reaches.
#
# Order matters and is not negotiable: Postgres has to be accepting TCP before PostgREST connects,
# the database-level JWT setting has to exist before either of them opens a pooled connection, and
# the schema migrations have to finish before the server starts answering.
set -uo pipefail

log() { echo "entrypoint: $*" >&2; }

# No fallback on purpose: the manifest declares the admin pair required with neither a default nor
# a generator, so the platform always supplies it. A default here would be the same root
# credential on every deploy in the world, and this dashboard owns a database.
: "${ADMIN_USERNAME:?ADMIN_USERNAME is required}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"
: "${JWT_SECRET:?JWT_SECRET is required}"
: "${ENCRYPTION_KEY:?ENCRYPTION_KEY is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"

# The app reads ROOT_ADMIN_*; the house convention across this registry is ADMIN_USERNAME +
# ADMIN_PASSWORD, so the manifest declares those and the rename happens here.
ROOT_ADMIN_USERNAME="$ADMIN_USERNAME"
ROOT_ADMIN_PASSWORD="$ADMIN_PASSWORD"
export ROOT_ADMIN_USERNAME ROOT_ADMIN_PASSWORD

# Container-internal plumbing. Everything stateful lives under /data, the only path that survives
# a restart; the manifest's `volume: true` is what puts a disk there.
PGDATA="${PGDATA:-/data/postgres}"
STORAGE_DIR="${STORAGE_DIR:-/data/storage}"
LOGS_DIR="${LOGS_DIR:-/data/logs}"
POSTGRES_DB="${POSTGRES_DB:-insforge}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}"
POSTGREST_BASE_URL="http://127.0.0.1:3000"
DENO_RUNTIME_URL="http://127.0.0.1:7133"
export PGDATA STORAGE_DIR LOGS_DIR POSTGRES_DB POSTGRES_USER POSTGRES_HOST POSTGRES_PORT
export DATABASE_URL POSTGREST_BASE_URL DENO_RUNTIME_URL

mkdir -p "$PGDATA" "$STORAGE_DIR" "$LOGS_DIR"

pg_pid=""
app_pid=""
pgrst_pid=""
deno_pid=""

# The two restart loops are subshells, so a flag set here would never reach them: SIGKILL is what
# stops them, and their current child is orphaned onto this process and goes when the container
# does.
#
# The app is stopped FIRST and waited for, then Postgres, on SIGINT, which is its fast-shutdown
# signal. That is the right order for a plain `docker stop`, where only PID 1 is signalled.
#
# It does NOT decide the order on this platform, and a reader chasing the stack trace in the logs
# should know that before they edit this function. On an `insta compute restart`, Postgres logs
# "received fast shutdown request" in the same millisecond as this function's first line, before
# anything here has signalled it: the stop signal reaches every process in the container, not just
# PID 1. So the app's pool loses its connections mid-shutdown and pg's BoundPool raises the
# resulting "terminating connection due to administrator command" as an unhandled 'error' event,
# which is a 40-line trace right after the app has logged "Shutting down gracefully".
#
# Cosmetic, and measured rather than assumed: the next boot reports "database system was shut down
# at <time>" and runs no recovery, so Postgres finished cleanly and nothing was lost.
stop() {
  trap - TERM INT
  log "shutting down"
  [ -n "$pgrst_pid" ] && kill -KILL "$pgrst_pid" 2>/dev/null
  [ -n "$deno_pid" ] && kill -KILL "$deno_pid" 2>/dev/null
  if [ -n "$app_pid" ]; then
    kill -TERM "$app_pid" 2>/dev/null
    wait "$app_pid" 2>/dev/null
  fi
  if [ -n "$pg_pid" ]; then
    kill -INT "$pg_pid" 2>/dev/null
    wait "$pg_pid" 2>/dev/null
  fi
  log "stopped"
  exit 0
}
trap stop TERM INT

# ---------------------------------------------------------------------------------------------
# Postgres
# ---------------------------------------------------------------------------------------------
# The base image's own entrypoint, not postgres directly: it runs initdb on an empty PGDATA,
# applies /docker-entrypoint-initdb.d/01-init.sql (upstream's roles and RLS event triggers)
# against $POSTGRES_DB, and gosu's to the postgres user, which postgres requires and this
# container is not.
#
# app.encryption_key is a server GUC insforge_pg_utils reads. Upstream passes it the same way, on
# the command line, from its Compose file.
log "starting postgres (data dir $PGDATA)"
docker-entrypoint.sh postgres \
  -c config_file=/etc/postgresql/postgresql.conf \
  -c app.encryption_key="$ENCRYPTION_KEY" &
pg_pid=$!

# TCP rather than the unix socket on purpose. The base entrypoint's first-boot phase runs a
# TEMPORARY server with listen_addresses='' that answers on the socket only, so a socket probe
# would report ready in the middle of initdb and everything after this would race it.
export PGPASSWORD="$POSTGRES_PASSWORD"
pg_ready=""
for _i in $(seq 1 180); do
  if pg_isready -q -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB"; then pg_ready=1; break; fi
  if ! kill -0 "$pg_pid" 2>/dev/null; then log "postgres exited before accepting connections"; exit 1; fi
  sleep 1
done
[ -n "$pg_ready" ] || { log "postgres did not accept connections within 180s"; exit 1; }
log "postgres is accepting connections"

# Upstream ships this as 02-jwt.sql, an initdb-time script. It runs here instead, on every boot,
# for two reasons: it is idempotent, and it is the one piece of first-boot setup that has to track
# a value the platform mints per deployment rather than one baked into the image. Upstream's
# Compose copy names the `postgres` database while POSTGRES_DB is `insforge`; the Zeabur template
# in the same repository names `insforge`, which is the one that matches this deployment.
psql -v ON_ERROR_STOP=1 -q -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "ALTER DATABASE \"$POSTGRES_DB\" SET \"app.settings.jwt_secret\" TO '$JWT_SECRET'" \
  -c "ALTER DATABASE \"$POSTGRES_DB\" SET \"app.settings.jwt_exp\" TO '3600'" \
  || { log "could not apply the database-level JWT settings"; exit 1; }

# ---------------------------------------------------------------------------------------------
# PostgREST: the REST data API the dashboard's table browser and every SDK query go through.
# ---------------------------------------------------------------------------------------------
# Supervised in a restart loop rather than treated as fatal. It exits on a connection it cannot
# establish, and one transient failure at boot would otherwise take the container down in a loop
# that never stays up long enough to read. Bound to loopback: only the declared port is routed,
# and nothing outside this container has any business reaching it.
(
  while :; do
    PGRST_DB_URI="$DATABASE_URL" \
    PGRST_DB_SCHEMA=public \
    PGRST_DB_ANON_ROLE=anon \
    PGRST_DB_POOL=50 \
    PGRST_JWT_SECRET="$JWT_SECRET" \
    PGRST_SERVER_HOST=127.0.0.1 \
    PGRST_SERVER_PORT=3000 \
    PGRST_OPENAPI_SERVER_PROXY_URI="$POSTGREST_BASE_URL" \
    PGRST_DB_CHANNEL_ENABLED=true \
    PGRST_DB_CHANNEL=pgrst \
      postgrest
    log "postgrest exited, restarting in 5s"
    sleep 5
  done
) &
pgrst_pid=$!

# ---------------------------------------------------------------------------------------------
# Deno: the edge-functions runtime. Same treatment, and for a stronger reason: with it down the
# rest of InsForge still works and only the Functions pages stop.
# ---------------------------------------------------------------------------------------------
(
  # /opt/insforge-functions, not /app/functions: see the COPY comment in the Dockerfile. Deno
  # would otherwise find /app/package.json, read it as an npm workspace root and refuse to start.
  cd /opt/insforge-functions || exit 0
  while :; do
    PORT=7133 DENO_ENV=production \
      deno run --unstable-worker-options --allow-net --allow-env \
        --allow-read=./worker-template.js server.ts
    log "deno runtime exited, restarting in 5s"
    sleep 5
  done
) &
deno_pid=$!

# ---------------------------------------------------------------------------------------------
# Schema, then the server.
# ---------------------------------------------------------------------------------------------
# Upstream's own boot command. node-pg-migrate keeps its ledger in system.migrations, so this is a
# no-op on every boot after the first; the first one is the slow part of a fresh deploy.
cd /app/backend || exit 1
log "running database migrations"
migrate_started=$(date +%s)
if ! npm run --silent migrate:up; then
  log "migrations failed; not starting the server"
  exit 1
fi
log "migrations finished in $(( $(date +%s) - migrate_started ))s"

log "starting the insforge server"
node /app/dist/server.js &
app_pid=$!

# Whichever of postgres and the server stops first brings the container down. Neither has any
# business exiting while the other lives, and the restart policy is on-failure, so the non-zero
# exit below is what gets the machine restarted rather than left half up.
wait -n "$pg_pid" "$app_pid"
log "postgres or the server exited; stopping so the platform restarts the machine"
kill -TERM "$app_pid" 2>/dev/null
wait "$app_pid" 2>/dev/null
kill -INT "$pg_pid" 2>/dev/null
wait "$pg_pid" 2>/dev/null
exit 1
