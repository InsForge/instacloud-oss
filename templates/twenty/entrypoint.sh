#!/bin/sh
# Upstream's docker-compose is four containers: postgres, redis, the server and the worker. The
# platform supplies the first one as a managed service; the other three live here, because a
# template manifest can declare neither a redis service nor a worker.
set -e

mkdir -p /data/redis "${STORAGE_LOCAL_PATH}"

# Holds the routed port while the rest of this script runs. Twenty's first boot needs about a
# minute before it listens, and the deploy probe waits 31 seconds. See boot-listener.mjs.
node /insta-boot-listener.mjs &
holder_pid=$!

# noeviction matches upstream's compose, and it is not a tuning preference: BullMQ job state lives
# in this instance, so an evicted key is a dropped job rather than a cold cache. appendonly keeps
# the queue and the registered cron jobs across a machine restart, which is what makes the volume
# worth mounting for redis at all.
redis-server \
  --dir /data/redis \
  --bind 127.0.0.1 \
  --port 6379 \
  --maxmemory-policy noeviction \
  --appendonly yes \
  --save '' &
redis_pid=$!

# Upstream's compose gates the server on a redis healthcheck. Same reason here: the setup below
# flushes the cache, which fails outright against a redis that is not listening yet.
attempt=0
until redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then
    echo "entrypoint: redis did not answer PING within 60s" >&2
    exit 1
  fi
  sleep 0.5
done
echo "entrypoint: redis is up"

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
#                    this script starts the processes itself.
twenty_version="$(cat /insta-twenty-version)"
setup_marker="/data/.twenty-setup-${twenty_version}"
register_cron=no

cd /app/packages/twenty-server

if [ -f "$setup_marker" ]; then
  echo "entrypoint: database already set up for twenty ${twenty_version}, going straight to the server"
elif [ "$(psql -tAc \
      "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'core')" \
      "${PG_DATABASE_URL}")" = f ]; then
  # A database with no `core` schema at all: the migrations below create it AT THIS IMAGE'S
  # VERSION, so the three steps upstream's entrypoint runs after them have nothing to find. The
  # upgrade command walks workspaces and there are none, and the two cache flushes clear a redis
  # this script created empty seconds ago. They are not free: each is a whole Nest context, 18 of
  # the 105 seconds a first boot measured, against a 90-second health gate. The full upstream path
  # still runs below whenever there IS a schema, which is the case those three steps exist for.
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

# The worker and the cron registration boot the same Nest context the server is booting, and this
# machine is small enough that three of them at once is measurable on the health gate's clock.
# Neither is what the gate probes, so both wait for the server to answer. `exec` replaces this
# subshell with the worker, which is what keeps $! usable as the worker's pid for the supervisor
# below.
start_worker() {
  until curl -fsS -o /dev/null "http://127.0.0.1:${NODE_PORT}/healthz"; do sleep 1; done
  # Deferred from the setup block. The jobs are BullMQ repeatables in the redis above, which the
  # volume keeps across restarts, so this only has to run when setup did. Non-fatal: a failure
  # costs the periodic syncs, not the CRM, and upstream's own entrypoint treats it the same way.
  if [ "$register_cron" = yes ]; then
    node dist/command/command cron:register:all \
      || echo "entrypoint: cron registration failed, sync jobs will not run until the next boot" >&2
  fi
  # The same two flags upstream's compose passes its worker, for the same reason: the block above
  # already did both, and a second migration run racing the first corrupts the metadata cache.
  export DISABLE_DB_MIGRATIONS=true DISABLE_CRON_JOBS_REGISTRATION=true
  exec node dist/queue-worker/queue-worker
}
start_worker &
worker_pid=$!

stop_all() { kill "$redis_pid" "$worker_pid" "$server_pid" 2>/dev/null || true; }
trap 'stop_all; exit 0' TERM INT

# PID 1 is this script and the restart policy is on-failure, so a dead child has to become a
# non-zero exit here or nothing restarts it. Without this the health gate would keep passing
# against a server whose worker died, which is a CRM that renders but runs no job.
while kill -0 "$redis_pid" 2>/dev/null \
   && kill -0 "$worker_pid" 2>/dev/null \
   && kill -0 "$server_pid" 2>/dev/null; do
  sleep 5
done

echo "entrypoint: a supervised process exited, stopping the other two" >&2
stop_all
exit 1
