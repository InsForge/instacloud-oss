#!/bin/bash
# Rakazo as one container.
#
# Upstream's compose stack is five services: Postgres, an API (Hono, 3100), a graphile-worker, a
# Vite preview of the web app (5173, same-origin-proxying /api and /rpc to the API), and a sandbox
# supervisor driving a Docker daemon. Server-side template deploys support web services only in
# v1, so the middle three run here as siblings, Postgres is the managed `db` service the manifest
# declares, and the supervisor is left out -- NOT because a template cannot have a Docker daemon.
# It can: this container ran its own dockerd and a real bot computer, and that was measured. What
# it cannot do is DRIVE one, because the Docker exec API lands outside the container on this
# platform. The manifest's SANDBOX_PROVIDER comment has the mechanism.
#
# Deliberately not `set -e`: every failure below is handled with a message that names the cause,
# because the CLI collapses a failed template deploy into "internal template deployment failure"
# and these lines are the only thing left to read.
set -uo pipefail

log() { echo "entrypoint: $*" >&2; }

# The volume, checked rather than fixed. Upstream's compose runs a busybox init container that
# chowns its named volume to 1000:1000 because a Docker volume arrives root-owned; here ownership
# follows the image's USER (node, uid 1000) so no chown is needed, and this process could not
# perform one anyway. What it can do is fail on the first line instead of as an EACCES thrown from
# inside tsx once three processes are already up.
mkdir -p "$DATA_DIR" 2>/dev/null
if ! touch "$DATA_DIR/.writable" 2>/dev/null; then
  log "FATAL: $DATA_DIR is not writable by uid $(id -u); the volume did not follow the image USER"
  exit 1
fi
rm -f "$DATA_DIR/.writable"

# Migrations first, to completion, single process. Both the API and the worker open the schema
# assuming it exists, and running `migrate deploy` from each would race on the migrations table.
log "applying database migrations"
if ! pnpm --filter @rakazo/db exec prisma migrate deploy; then
  log "FATAL: prisma migrate deploy failed; the lines above are Prisma's own. A connection or TLS"
  log "       error here is about DATABASE_URL, which the platform binds from the db service."
  exit 1
fi

log "starting api, worker and web"
pnpm --filter @rakazo/api start &
api=$!
pnpm --filter @rakazo/worker start &
worker=$!
# --strictPort so a port surprise is a crash rather than a preview server that silently binds
# somewhere the platform is not routing to. host/port also come from the vite config, which reads
# WEB_PORT; passing them keeps this script's contract with the manifest explicit in one place.
pnpm --filter @rakazo/web preview --host 0.0.0.0 --port "$WEB_PORT" --strictPort &
web=$!

# The three are one application, so the first one to go down takes the container with it: an API
# with no worker silently stops running routines and waking bots, and a dead preview server is an
# unreachable UI behind a machine that still looks alive. The platform restarts on FAILURE only, so
# the exit status has to be non-zero even when the child exited 0 -- a clean exit here is a machine
# that lies there and is never brought back.
wait -n
code=$?
log "a child process exited with status $code; stopping the other two"
kill -TERM "$api" "$worker" "$web" 2>/dev/null
wait "$api" "$worker" "$web" 2>/dev/null
if [ "$code" -eq 0 ]; then code=1; fi
exit "$code"
