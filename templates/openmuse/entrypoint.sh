#!/bin/bash
set -euo pipefail

# Neither gets a fallback on purpose. The manifest declares both required with no default and no
# generator, so the platform always supplies them; a missing one means the image was started some
# other way, and inventing `admin` there would publish a personal workspace, its files and its
# browsing sessions to whoever finds the URL.
: "${ADMIN_USERNAME:?ADMIN_USERNAME is required}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

# apr1 rather than bcrypt: nginx documents apr1, crypt() and {SHA} as the forms it reads, and this
# file is only ever read by the nginx worker in this container.
htpasswd -bcm /etc/nginx/htpasswd "$ADMIN_USERNAME" "$ADMIN_PASSWORD" >/dev/null
chown root:www-data /etc/nginx/htpasswd
chmod 640 /etc/nginx/htpasswd

mkdir -p "$DATA_DIR"

# OpenMuse wants 32 random bytes in STANDARD base64 here, and checks the round-trip: it rejects the
# base64url a `secret:N` generator would mint, so this cannot be an env.generated value. It also
# cannot be thrown away on every start, or the Google refresh tokens it encrypts stop decrypting
# after a restart. So: the operator's value if there is one, otherwise one minted once onto the
# volume.
KEY_FILE="$DATA_DIR/token-encryption-key"
if [ -z "${TOKEN_ENCRYPTION_KEY:-}" ]; then
  if [ ! -s "$KEY_FILE" ]; then
    ( umask 077; openssl rand -base64 32 > "$KEY_FILE" )
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
