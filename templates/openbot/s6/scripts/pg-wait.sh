#!/command/with-contenv sh
# Wait for the embedded cluster to ACCEPT connections, not merely to have been started.
#
# WHY. Upstream's `migrate` depends on `postgres`, and for an s6 longrun "started" means the process
# was executed. PostgreSQL answers on the socket before it finishes coming up and refuses what
# arrives meanwhile with `FATAL: the database system is starting up` (SQLSTATE 57P03), so the two
# are in a race that nothing arbitrates. Measured on this platform, the first deploy of this
# template lost it by 66 milliseconds:
#
#   02:57:27.196  postgres   starting PostgreSQL 16.15
#   02:57:27.256  postgres   FATAL: the database system is starting up
#   02:57:27.259  migrate    Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"
#   02:57:27.262  postgres   database system is ready to accept connections
#   02:57:27.262  s6-rc      warning: unable to start service migrate: command exited 1
#
# Three milliseconds early. And the cost is the whole deployment rather than a retry: `api` depends
# on `migrate`, so it never starts, nothing listens, and the platform reports only that the app was
# not ready on its routed port. A laptop usually wins this race, which is why it ships this way.
#
# This is an ordering fix, not a patch: upstream's `migrate` is untouched and simply runs later.
set -eu
[ "${EMBEDDED_POSTGRES:-off}" = "on" ] || exit 0

BIN=/usr/lib/postgresql/16/bin
# Seconds, not attempts: a first boot is `initdb` plus a fresh start, but a restart replays the WAL
# first, and an unclean stop (which an idle-stopped machine is) makes that the slow case.
DEADLINE=60

i=0
while [ "$i" -lt "$DEADLINE" ]; do
  # pg_isready does not authenticate; it asks the postmaster whether it is accepting, which is
  # exactly the question. 0 accepting, 1 rejecting (still starting), 2 no response yet.
  if "$BIN/pg_isready" -h 127.0.0.1 -p 5432 -q; then
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "pg-wait: the embedded cluster did not accept connections within ${DEADLINE}s" >&2
exit 1
