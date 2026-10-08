#!/bin/bash
set -euo pipefail

# No credential is written here: in live mode OpenMuse authenticates itself with OPENMUSE_ACCESS_KEY
# and the Bearer sessions it mints, and nginx carries no auth of its own. The access key reaches the
# server straight from the platform's environment; this script never reads it.

mkdir -p "$DATA_DIR"

# OpenMuse wants 32 random bytes in STANDARD base64 here, and checks the round-trip: it rejects the
# base64url a `secret:N` generator would mint, so this cannot be an env.generated value. It also
# cannot be thrown away on every start, or the Google refresh tokens it encrypts stop decrypting
# after a restart. So: the operator's value if there is one, otherwise one minted once onto the
# volume.
KEY_FILE="$DATA_DIR/token-encryption-key"
if [ -z "${TOKEN_ENCRYPTION_KEY:-}" ]; then
  if [ ! -s "$KEY_FILE" ]; then
    # Write to a temp file and rename it into place. A rename on the same volume is atomic, so an
    # interrupted or failed openssl never leaves a half-written key that the next boot would read as
    # valid (-s passes on any nonempty file) and OpenMuse would then reject on its round-trip check.
    ( umask 077; openssl rand -base64 32 > "$KEY_FILE.tmp" && mv -f "$KEY_FILE.tmp" "$KEY_FILE" )
  fi
  TOKEN_ENCRYPTION_KEY="$(cat "$KEY_FILE")"
  export TOKEN_ENCRYPTION_KEY
fi

stopping=0
trap 'stopping=1; kill -TERM "${node_pid:-}" "${nginx_pid:-}" 2>/dev/null || true' TERM INT

# PORT is pinned here rather than in the manifest because the platform injects its own PORT, equal
# to the routed port, and it wins over env.fixed. nginx owns that port; the API answers on loopback
# 8787 behind it, which is what nginx.conf proxies to.
PORT=8787 node /app/dist/apps/server/src/index.js &
node_pid=$!
nginx -g 'daemon off;' &
nginx_pid=$!

# Whichever half exits first takes the container with it. Without this, a crashed API leaves nginx
# answering 502 behind a process that is still alive, so the platform never restarts the machine
# and the health gate is the only thing that notices.
status=0
wait -n || status=$?
kill -TERM "$node_pid" "$nginx_pid" 2>/dev/null || true
wait || true

# A deliberate stop exits clean. Anything else exits non-zero, including a half that managed to
# exit 0 on its own: the restart policy is on-failure, so a clean exit here would leave the
# machine running with nothing listening on it.
if [ "$stopping" = 1 ]; then exit 0; fi
[ "$status" -ne 0 ] || status=1
exit "$status"
