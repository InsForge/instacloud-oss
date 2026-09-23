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

# Twenty's sign-up gate is `IS_MULTIWORKSPACE_ENABLED || workspaceCount === 0`, so exactly one
# account can ever be created on a single-workspace instance and it belongs to whoever opens the
# URL first. ADMIN_EMAIL and ADMIN_PASSWORD take that slot at deploy time instead. See
# seed-admin.mjs, which posts upstream's own public sign-up mutation.
#
# Only until there is an ACTIVE workspace, which is both the idempotence guard and the thing that
# keeps a restart from touching an account whose password the operator has since changed. ACTIVE
# rather than "exists" because a workspace row is written before it is usable: a boot that created
# one and then died leaves an instance that would otherwise finish building itself, and write its
# example records, whenever a stranger first opened the URL. seed-admin.mjs picks that up instead
# of making a second workspace. The window between the server listening and this returning is a
# few seconds on a URL nobody has been given yet; it cannot be closed from here, because the
# mutations need the server up and the server being up is what opens the port.
seed_admin() {
  if [ "$(psql -tAc \
        "SELECT count(*) FROM core.workspace WHERE \"activationStatus\" = 'ACTIVE'" \
        "${PG_DATABASE_URL}")" != 0 ]; then
    echo "entrypoint: an active workspace already exists, leaving its admin account alone"
    return
  fi
  if ! node /insta-seed-admin.mjs; then
    echo "entrypoint: could not create the admin account; twenty is still up and its sign-up page is open to the first visitor" >&2
    return
  fi
  clear_sample_data
}

# Twenty fills a workspace it activates with example records — Airbnb, Anthropic, Stripe and
# friends, five people, six opportunities and a dashboard. Upstream shows them to the person who
# just created the workspace in their own browser; here the deploy creates it, so without this
# the operator opens their new CRM and finds somebody else's demo in it. See
# clear-sample-data.sql for what is removed, why the `SYSTEM` filter cannot reach a real record,
# and why the two prefilled workflows stay. Everything here is non-fatal: the worst case is the
# workspace upstream would have given them anyway.
clear_sample_data() {
  case "${SAMPLE_DATA:-}" in
    1 | y | yes | true | on | Y | YES | True | TRUE | On | ON)
      echo "entrypoint: SAMPLE_DATA is set, keeping twenty's example records"
      return
      ;;
  esac

  # `signUpInNewWorkspace` returns as soon as the workspace row exists; building its schema,
  # installing the pre-installed apps and writing the example records all happen behind that
  # answer and take another minute. ACTIVE is the last thing activateWorkspace writes and the
  # prefill is committed before it, so it is the barrier to wait on rather than a sleep.
  attempt=0
  until [ "$(psql -tAc \
        "SELECT count(*) FROM core.workspace WHERE \"activationStatus\" = 'ACTIVE'" \
        "${PG_DATABASE_URL}")" != 0 ]; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 150 ]; then
      echo "entrypoint: the workspace was still not active after 5 minutes, leaving twenty's example records in it" >&2
      return
    fi
    sleep 2
  done

  # One workspace per instance (IS_MULTIWORKSPACE_ENABLED is off), and its schema name is a base36
  # of the workspace id rather than the id, so it is read back rather than derived here.
  schema="$(psql -tAc \
    "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace\_%' ORDER BY nspname LIMIT 1" \
    "${PG_DATABASE_URL}")"
  if [ -z "$schema" ]; then
    echo "entrypoint: the workspace is active but has no schema, leaving twenty's example records alone" >&2
    return
  fi

  if ! left="$(psql -q -tA -v ON_ERROR_STOP=1 -v schema="$schema" \
      -f /insta-clear-sample-data.sql "${PG_DATABASE_URL}" 2>&1)"; then
    echo "entrypoint: could not remove twenty's example records, the workspace still has them: ${left}" >&2
    return
  fi
  echo "entrypoint: removed twenty's example companies, people, opportunities and dashboard; ${left} left"
}

# Both of these boot a Nest context of their own, and doing that beside the one the server is
# booting is time the health gate is counting. Neither is what the gate probes, so both wait for
# the server to answer.
post_boot() {
  until curl -fsS -o /dev/null "http://127.0.0.1:${NODE_PORT}/healthz"; do sleep 1; done
  # First, because it is the one thing an operator is waiting on: the URL is useless until the
  # account they typed at the deploy prompt exists.
  seed_admin
  # Deferred from the setup block. The jobs are BullMQ repeatables in the managed redis, which
  # outlives both compute services, so this only has to run when setup did. The `jobs` worker is
  # what executes them. Non-fatal: a failure costs the periodic syncs, not the CRM, and upstream's
  # own entrypoint treats it the same way.
  if [ "$register_cron" = yes ]; then
    node dist/command/command cron:register:all \
      || echo "entrypoint: cron registration failed, sync jobs will not run until the next boot" >&2
  fi
}
post_boot &
post_boot_pid=$!

stop_all() { kill "$post_boot_pid" "$server_pid" 2>/dev/null || true; }
trap 'stop_all; exit 0' TERM INT

# PID 1 is this script and the restart policy is on-failure, so a dead server has to become a
# non-zero exit here or nothing restarts it. post_boot is deliberately not supervised: it finishes
# on its own and a machine whose seed already ran has no reason to restart.
while kill -0 "$server_pid" 2>/dev/null; do
  sleep 5
done

echo "entrypoint: the twenty server exited" >&2
stop_all
exit 1
