#!/usr/bin/env bash
#
# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements.  See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License.  You may obtain a copy of the License at
#
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# Upstream's image ships gunicorn and nothing else: it never migrates the metadata database,
# never creates an account and never syncs the role definitions. docker-compose does all three in
# a separate init container (docker/docker-init.sh), which a single-service template has nowhere
# to put. This is that init, inline, behind a port holder so the deploy's connect probe is not
# left waiting on the migrations.
set -uo pipefail

stamp() { date -u +%H:%M:%SZ; }
say() { echo "entrypoint $(stamp): $*"; }

/app/.venv/bin/python /insta-boot-listener.py &
holder_pid=$!

release_port() {
  kill "$holder_pid" 2>/dev/null || true
  wait "$holder_pid" 2>/dev/null || true
}
die() { say "$1" >&2; release_port; exit 1; }
trap 'release_port; exit 143' TERM INT

before="$(/app/.venv/bin/python /insta-db-revision.py)"
say "metadata database is at alembic revision ${before}"

say "applying migrations"
superset db upgrade || die "db upgrade failed, see the traceback above"
after="$(/app/.venv/bin/python /insta-db-revision.py)"
say "migrations done, alembic revision ${after}"

# Role definitions are derived from the code and the schema, so they only need rebuilding when one
# of the two moved. Keying that on the revision rather than on a file marker is what makes a wake
# from scale-to-zero cheap without going stale when the database is restored under the volume.
if [ "${before}" != "${after}" ]; then
  say "schema moved ${before} -> ${after}, syncing roles and permissions"
  superset init || die "superset init failed, see the traceback above"
  say "roles and permissions synced"
else
  say "schema unchanged, skipping the role sync"
fi

# Create-if-missing, not create-or-update: flask-appbuilder refuses a username that already
# exists, which is the outcome on every boot after the first. Changing ADMIN_PASSWORD on a
# deployed instance therefore does not move the account's password; the UI does that.
say "ensuring the admin account exists"
if superset fab create-admin \
    --username "${ADMIN_USERNAME}" \
    --password "${ADMIN_PASSWORD}" \
    --email "${ADMIN_EMAIL:-admin@example.com}" \
    --firstname Superset \
    --lastname Admin; then
  say "created the admin account"
else
  # Not swallowed: flask-appbuilder's own reason is on stderr above this line. On every boot
  # after the first it reads "username already exists", which is not a failure.
  say "create-admin made no account, see its message above"
fi

release_port
trap - TERM INT
say "handing the port to gunicorn"
exec /app/docker/entrypoints/run-server.sh
