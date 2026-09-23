#!/bin/sh
# Upstream's docker-compose is four containers: postgres, redis, the server and the worker. The
# platform supplies the first two as managed services, and the other two are the `crm` and `jobs`
# services in the manifest, both running this image. Which one a container is comes from
# INSTA_TWENTY_ROLE, because a manifest cannot set a container command and upstream ships the
# server and the worker as the same image started differently.
set -e

mkdir -p "${STORAGE_LOCAL_PATH}"
cd /app/packages/twenty-server

twenty_version="$(cat /insta-twenty-version)"

# ---------------------------------------------------------------------------------------------
# The worker role. Nothing is routed to it and its health verdict is the machine's state, so the
# only thing it has to get right is not dying before the server has made the schema.
# ---------------------------------------------------------------------------------------------
if [ "${INSTA_TWENTY_ROLE}" = worker ]; then
  # Both services are created at once and neither waits for the other, so on a first deploy this
  # one would boot against a database with no `core` schema. Twenty reads its own configuration
  # out of that schema (IS_CONFIG_VARIABLES_IN_DB_ENABLED defaults to true), so the process exits,
  # the machine restarts it, and a crash loop through the first two minutes is a failed deploy of
  # a template that is otherwise fine. Upstream's compose says the same thing as
  # `depends_on: server: service_healthy`, which a manifest has no way to express.
  #
  # `core.workspace` rather than the schema alone: the schema appears at the start of the
  # migrations and this table is written by them, so it is the closer barrier. A DB probe rather
  # than a request to SERVER_URL so the wait does not depend on the edge being reachable from
  # here. Not under `set -e`, since a database still accepting no connections makes psql exit
  # non-zero and that is a reason to wait rather than to die.
  attempt=0
  until [ "$(psql -tAc "SELECT to_regclass('core.workspace') IS NOT NULL" \
        "${PG_DATABASE_URL}" 2>/dev/null)" = t ]; do
    attempt=$((attempt + 1))
    # Ten minutes, as a backstop rather than a tuning knob. Past it the interesting error is the
    # application's own, with its own message, rather than this script's silence.
    if [ "$attempt" -ge 120 ]; then
      echo "worker: no core schema after 10 minutes, starting anyway so the failure is twenty's own" >&2
      break
    fi
    # Every sixth turn, so half a minute of waiting is one line rather than six.
    if [ "$((attempt % 6))" -eq 1 ]; then
      echo "worker: waiting for the server to create the schema for twenty ${twenty_version}"
    fi
    sleep 5
  done
  echo "worker: starting twenty ${twenty_version}'s queue worker"
  # The same two flags upstream's compose passes its worker, and the manifest sets them too. Kept
  # here as well so the image is correct whatever env it is handed.
  export DISABLE_DB_MIGRATIONS=true DISABLE_CRON_JOBS_REGISTRATION=true
  exec node dist/queue-worker/queue-worker
fi

# ---------------------------------------------------------------------------------------------
# The server role, from here down.
# ---------------------------------------------------------------------------------------------

# Holds the routed port while the rest of this script runs. Twenty's first boot needs about a
# minute before it listens, and the deploy probe waits 31 seconds. See boot-listener.mjs.
node /insta-boot-listener.mjs &
holder_pid=$!

# Everything between here and `node dist/main` is on the deploy's 90-second health gate, because
# Twenty does not listen until its schema exists. Three cases, doing as little as each one allows:
#
#   marker present   nothing. The marker records the version setup last ran for, read from the
#                    file the Dockerfile writes out of its own FROM tag so a base-image bump
#                    cannot forget to invalidate it. It lives on the volume beside the uploads,
#                    and losing the volume costs one idempotent re-run.
#   no core schema   the migrations only. See the branch.
#   otherwise        upstream's own entrypoint, which is the path its extra steps exist for: a
#                    schema written by an older image. `true` is the argument it execs, because
#                    this script starts the server itself.
setup_marker="/data/.twenty-setup-${twenty_version}"
register_cron=no

if [ -f "$setup_marker" ]; then
  echo "entrypoint: database already set up for twenty ${twenty_version}, going straight to the server"
elif [ "$(psql -tAc \
      "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'core')" \
      "${PG_DATABASE_URL}")" = f ]; then
  # A database with no `core` schema at all: the migrations below create it AT THIS IMAGE'S
  # VERSION, so the three steps upstream's entrypoint runs after them have nothing to find. The
  # upgrade command walks workspaces and there are none, and the two cache flushes clear a redis
  # nothing has written to yet. They are not free: each is a whole Nest context, 18 of the 105
  # seconds a first boot measured, against a 90-second health gate. The full upstream path still
  # runs below whenever there IS a schema, which is the case those three steps exist for.
  echo "entrypoint: empty database, creating the schema for twenty ${twenty_version}"
  yarn database:init:prod
  touch "$setup_marker"
  register_cron=yes
else
  echo "entrypoint: running upstream setup and migrations for twenty ${twenty_version}"
  # Cron registration is upstream's last setup step and the slowest thing standing between here
  # and a listening server, so it is deferred to below where it happens after the server is up.
  DISABLE_CRON_JOBS_REGISTRATION=true /app/entrypoint.sh true
  touch "$setup_marker"
  register_cron=yes
fi

# Hand the port over. The real server needs a few seconds to bind after this, and a refused
# connection in that window is what the health gate retries through.
kill "$holder_pid" 2>/dev/null || true
wait "$holder_pid" 2>/dev/null || true

node dist/main &
server_pid=$!

# Nothing here creates an account or touches a record. Twenty's own sign-up gate is
# `IS_MULTIWORKSPACE_ENABLED || workspaceCount === 0`, so the instance comes up with its welcome
# page open and the first visitor makes the workspace, exactly as upstream ships it, example
# records and all.
#
# Cron registration boots a Nest context of its own, and doing that beside the one the server is
# booting is time the health gate is counting. It is not what the gate probes, so it waits for the
# server to answer first.
post_boot() {
  until curl -fsS -o /dev/null "http://127.0.0.1:${NODE_PORT}/healthz"; do sleep 1; done
  # Deferred from the setup block. The jobs are BullMQ repeatables in the managed redis, which
  # outlives both compute services, so this only has to run when setup did. The `jobs` worker is
  # what executes them. Non-fatal: a failure costs the periodic syncs, not the CRM, and upstream's
  # own entrypoint treats it the same way.
  if [ "$register_cron" = yes ]; then
    node dist/command/command cron:register:all \
      || echo "entrypoint: cron registration failed, sync jobs will not run until the next boot" >&2
  fi
  # Says which of the two states the instance came up in, because they look identical from the
  # outside and only one of them still has an account to claim. Read rather than assumed: a
  # restart of a CRM in use must not print an invitation that is no longer true.
  if [ "$(psql -tAc "SELECT count(*) FROM core.workspace" "${PG_DATABASE_URL}")" = 0 ]; then
    echo "entrypoint: no workspace yet, twenty's sign-up page is open to the first visitor"
  else
    echo "entrypoint: twenty is up, with the workspace it already had"
  fi
}
post_boot &
post_boot_pid=$!

stop_all() { kill "$post_boot_pid" "$server_pid" 2>/dev/null || true; }
trap 'stop_all; exit 0' TERM INT

# PID 1 is this script and the restart policy is on-failure, so a dead server has to become a
# non-zero exit here or nothing restarts it. post_boot is deliberately not supervised: it finishes
# on its own, and a failed cron registration is a reason to log rather than to restart the CRM.
while kill -0 "$server_pid" 2>/dev/null; do
  sleep 5
done

echo "entrypoint: the twenty server exited" >&2
stop_all
exit 1
