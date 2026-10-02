#!/bin/sh
# Twenty's server and queue worker share this container because local storage needs one disk.
set -e

mkdir -p "${STORAGE_LOCAL_PATH}"
cd /app/packages/twenty-server

# Answers 503 until the server binds, so the 31s deploy probe outlasts the migrations.
node /insta-boot-listener.mjs &
holder_pid=$!

# Setup runs every boot, as upstream's does: a volume marker went stale on a database restore.
has_schema="$(psql -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'core')" "${PG_DATABASE_URL}")"
if [ "$has_schema" = f ]; then
  echo "entrypoint: empty database, creating the schema"
  # Init builds the schema at this version, so the upgrade steps below would only burn gate time.
  yarn database:init:prod
else
  echo "entrypoint: running upstream's upgrade on the existing schema"
  # Upstream warns and boots on these failures; the next boot retries them.
  node dist/command/command cache:flush || echo "entrypoint: cache:flush failed, continuing" >&2
  node dist/command/command upgrade || echo "entrypoint: upgrade finished with errors, the next boot retries it" >&2
  node dist/command/command cache:flush || echo "entrypoint: cache:flush failed, continuing" >&2
fi

kill "$holder_pid" 2>/dev/null || true
wait "$holder_pid" 2>/dev/null || true

node dist/main &
server_pid=$!

wait_for_server() {
  until curl -fs -o /dev/null "http://127.0.0.1:${NODE_PORT}/healthz"; do sleep 1; done
}

# Kept off the health gate's clock; registration is idempotent, so every boot repairs a failed one.
post_boot() {
  wait_for_server
  node dist/command/command cron:register:all || echo "entrypoint: cron registration failed, the next boot retries it" >&2
  if [ "$(psql -tAc "SELECT count(*) FROM core.workspace" "${PG_DATABASE_URL}")" = 0 ]; then
    echo "entrypoint: no workspace yet, twenty's sign-up page is open to the first visitor"
  else
    echo "entrypoint: twenty is up, with the workspace it already had"
  fi
}

# Upstream starts the worker once the server is healthy and restarts it alone when it dies.
run_worker() {
  worker_pid=""
  trap 'kill "$worker_pid" 2>/dev/null; wait "$worker_pid" 2>/dev/null; exit 0' TERM
  wait_for_server
  while :; do
    echo "entrypoint: starting twenty's queue worker"
    node dist/queue-worker/queue-worker &
    worker_pid=$!
    status=0
    wait "$worker_pid" || status=$?
    echo "entrypoint: the queue worker exited with $status, restarting it in 5 seconds" >&2
    sleep 5
  done
}

post_boot &
post_boot_pid=$!
run_worker &
worker_loop_pid=$!

stop_all() {
  kill "$post_boot_pid" "$worker_loop_pid" "$server_pid" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap 'stop_all; exit 0' TERM INT

# PID 1 exiting is what restarts the container, so a dead server has to end this script.
while kill -0 "$server_pid" 2>/dev/null; do
  sleep 5
done

echo "entrypoint: the twenty server exited" >&2
stop_all
exit 1
