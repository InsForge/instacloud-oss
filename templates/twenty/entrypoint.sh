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
# only thing it has to get right is not consuming jobs before the server has finished the schema.
# ---------------------------------------------------------------------------------------------
if [ "${INSTA_TWENTY_ROLE}" = worker ]; then
  # Upstream's compose starts its worker on `depends_on: server: service_healthy`, which a
  # manifest has no way to express, so the wait is here. It polls the server's own health path,
  # the same one the manifest declares, because that is the only signal that setup, the
  # migrations and the workspace upgrades are all finished: the port is answered by a 503 holder
  # until `node dist/main` takes it over, and `node dist/main` starts below the setup block.
  #
  # A database probe is not enough, and probing `core.workspace` is what this used to do. That
  # table exists on every boot after the first, so on an upgrade the wait returned at once and
  # this worker consumed jobs against a schema the server was still migrating.
  # A wall-clock deadline rather than an attempt count, because an attempt is a refused
  # connection in milliseconds or a request that burns the whole --max-time, and counting turns
  # would make the bound anything between ten minutes and half an hour.
  deadline=$(($(date +%s) + 600))
  attempt=0
  until curl -fs -o /dev/null --max-time 10 "${SERVER_URL}/healthz"; do
    # Ten minutes, then exit rather than start anyway. The restart policy brings the container
    # back and it waits again, so a migration slower than this costs a restart instead of a
    # worker on a half-migrated schema, and a server that never becomes healthy shows up as a
    # crash loop rather than as a worker that silently never started.
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "worker: the server has not passed its health check in 10 minutes, restarting to wait again" >&2
      exit 1
    fi
    # Every sixth turn, so roughly half a minute of waiting is one line rather than six.
    if [ "$((attempt % 6))" -eq 0 ]; then
      echo "worker: waiting for the twenty ${twenty_version} server to pass its health check"
    fi
    attempt=$((attempt + 1))
    sleep 5
  done
  echo "worker: the server is healthy, starting twenty ${twenty_version}'s queue worker"
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
#   marker present   nothing. The marker records the version setup last COMPLETED for, read from
#                    the file the Dockerfile writes out of its own FROM tag so a base-image bump
#                    cannot forget to invalidate it. It lives on the volume beside the uploads,
#                    and losing the volume costs one idempotent re-run.
#   no core schema   the migrations only. See the branch.
#   otherwise        the upgrade upstream runs on a schema an older image wrote. See the branch.
setup_marker="/data/.twenty-setup-${twenty_version}"

if [ -f "$setup_marker" ]; then
  echo "entrypoint: database already set up for twenty ${twenty_version}, going straight to the server"
elif [ "$(psql -tAc \
      "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'core')" \
      "${PG_DATABASE_URL}")" = f ]; then
  # A database with no `core` schema at all: the migrations below create it AT THIS IMAGE'S
  # VERSION, so the three steps in the other branch have nothing to find. The upgrade command
  # walks workspaces and there are none, and the two cache flushes clear a redis nothing has
  # written to yet. They are not free: each is a whole Nest context, 18 of the 105 seconds a
  # first boot measured, against a 90-second health gate.
  #
  # `set -e` is what guards the marker here: a failed init kills this script before the touch.
  echo "entrypoint: empty database, creating the schema for twenty ${twenty_version}"
  yarn database:init:prod
  touch "$setup_marker"
else
  # The three steps upstream's own entrypoint runs on an existing schema, run here rather than by
  # calling /app/entrypoint.sh, because that wrapper turns each of their failures into a warning
  # and still exits 0. Staying up after a partial upgrade is upstream's call and it is kept: the
  # server still starts, and a CRM that serves most of its workspaces beats one that will not
  # boot. What cannot be kept is recording that as done. The marker is written only when all
  # three succeeded, so a transient failure is retried on the next boot instead of being skipped
  # for the life of this image.
  #
  # `node dist/command/command` is exactly what `yarn command:prod` runs, without the extra yarn
  # process. Cron registration is upstream's next step and the slowest thing standing between
  # here and a listening server, so it is not here: post_boot runs it after the server answers.
  echo "entrypoint: upgrading an existing schema to twenty ${twenty_version}"
  setup_ok=yes
  node dist/command/command cache:flush || setup_ok=no
  node dist/command/command upgrade     || setup_ok=no
  node dist/command/command cache:flush || setup_ok=no
  if [ "$setup_ok" = yes ]; then
    touch "$setup_marker"
  else
    echo "entrypoint: the upgrade did not finish cleanly, so the next boot runs it again" >&2
  fi
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
  until curl -fs -o /dev/null "http://127.0.0.1:${NODE_PORT}/healthz"; do sleep 1; done
  # Every boot, which is what upstream's entrypoint does too, and not only the boots that ran
  # setup. The jobs are BullMQ repeatables in the managed redis and registering them is
  # idempotent, so a boot after a failed registration, or after the redis lost them, puts them
  # back; keying it on "setup ran" is what made the old failure message untrue, because the
  # marker was already written and the next boot skipped registration for good. The `jobs` worker
  # is what executes them. Non-fatal: a failure costs the periodic syncs, not the CRM, and
  # upstream's own entrypoint treats it the same way.
  node dist/command/command cron:register:all \
    || echo "entrypoint: cron registration failed, the next boot will try again" >&2
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
