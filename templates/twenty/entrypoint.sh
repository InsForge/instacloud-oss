#!/bin/sh
# Upstream's docker-compose is four containers: postgres, redis, the server and the worker. The
# platform supplies the first one as a managed service; the other three live here, because a
# template manifest can declare neither a redis service nor a worker.
set -e

mkdir -p /data/redis "${STORAGE_LOCAL_PATH}"

# noeviction matches upstream's compose, and it is not a tuning preference: BullMQ job state lives
# in this instance, so an evicted key is a dropped job rather than a cold cache. appendonly keeps
# the queue and the cron registrations across a machine restart, which is what makes the volume
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
# On an empty database this is the slow part of the first boot and the server cannot serve before
# it finishes.
/app/entrypoint.sh true

cd /app/packages/twenty-server

# The same two flags upstream's compose passes its worker, for the same reason: the block above
# already did both, and a second migration run racing the first corrupts the metadata cache.
DISABLE_DB_MIGRATIONS=true DISABLE_CRON_JOBS_REGISTRATION=true \
  node dist/queue-worker/queue-worker &
worker_pid=$!

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
