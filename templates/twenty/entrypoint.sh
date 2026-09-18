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

# Upstream's entrypoint creates the schema, runs the migrations and registers the cron jobs, then
# execs its argument. `true` is that argument, because this script starts the processes itself.
#
# It replays `command:prod upgrade` and two cache flushes on EVERY boot, and each one pays for a
# whole Nest context: about 50 seconds between them, spent deciding there is nothing to do
# whenever the schema already matches the image. The marker records the version setup last ran
# for, read from the file the Dockerfile writes out of its own FROM tag so a base-image bump
# cannot forget to invalidate it. It lives on the volume beside the uploads, and losing the volume
# costs one idempotent re-run.
twenty_version="$(cat /insta-twenty-version)"
setup_marker="/data/.twenty-setup-${twenty_version}"
register_cron=no

if [ -f "$setup_marker" ]; then
  echo "entrypoint: database already set up for twenty ${twenty_version}, going straight to the server"
else
  echo "entrypoint: running upstream setup and migrations for twenty ${twenty_version}"
  # Cron registration is upstream's last setup step and the slowest thing standing between here
  # and a listening server, so it is deferred to below where it overlaps the server's own boot.
  DISABLE_CRON_JOBS_REGISTRATION=true /app/entrypoint.sh true
  touch "$setup_marker"
  register_cron=yes
fi

cd /app/packages/twenty-server

# The same two flags upstream's compose passes its worker, for the same reason: the block above
# already did both, and a second migration run racing the first corrupts the metadata cache.
DISABLE_DB_MIGRATIONS=true DISABLE_CRON_JOBS_REGISTRATION=true \
  node dist/queue-worker/queue-worker &
worker_pid=$!

# Deferred from the setup block. The jobs are BullMQ repeatables in the redis above, which the
# volume keeps across restarts, so this only has to run when setup did. Non-fatal: a failure here
# costs the periodic syncs, not the CRM, and upstream's own entrypoint treats it the same way.
if [ "$register_cron" = yes ]; then
  (node dist/command/command cron:register:all \
    || echo "entrypoint: cron registration failed, sync jobs will not run until the next boot" >&2) &
fi

# Hand the port over. The real server needs a few seconds to bind after this, and a refused
# connection in that window is what the health gate retries through.
kill "$holder_pid" 2>/dev/null || true
wait "$holder_pid" 2>/dev/null || true

node dist/main &
server_pid=$!

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
