#!/bin/bash
# The deploy form speaks ADMIN_USERNAME / ADMIN_PASSWORD, the way every other template here does.
# Upstream's entrypoint reads CLICKHOUSE_USER / CLICKHOUSE_PASSWORD and builds
# /etc/clickhouse-server/users.d/default-user.xml out of them on every boot, removing the stock
# `default` user as it goes. This maps the one pair onto the other and then hands over: upstream's
# script is still what starts the server.
set -eo pipefail

if [ -z "${ADMIN_USERNAME:-}" ] || [ -z "${ADMIN_PASSWORD:-}" ]; then
    echo "$0: ADMIN_USERNAME and ADMIN_PASSWORD are both required." >&2
    echo "$0: without them upstream's entrypoint leaves the 'default' user bound to localhost," >&2
    echo "$0: so the server would come up healthy and refuse every connection from outside." >&2
    exit 1
fi

CLICKHOUSE_USER="${ADMIN_USERNAME}"
CLICKHOUSE_PASSWORD="${ADMIN_PASSWORD}"
export CLICKHOUSE_USER CLICKHOUSE_PASSWORD

exec /entrypoint.sh "$@"
