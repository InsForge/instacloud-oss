#!/bin/bash
# Starts the five processes upstream runs in five containers, then nginx on the routed port.
#
# pipefail is load-bearing: without it a failed `openssl passwd` still writes a usable-looking
# htpasswd, and every request would then be answered by a blanket 401 that reads as a live site.
set -euo pipefail

# No fallback on purpose: the manifest declares both required with no default, so the platform
# always supplies them. A missing one means the image was started some other way, and inventing
# `admin` there would put a virtual office with a map editor on the open internet.
: "${ADMIN_USERNAME:?ADMIN_USERNAME is required}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

# htpasswd's field separator; a username carrying one would smuggle in a second, empty credential.
case "$ADMIN_USERNAME" in *:* | *$'\n'*)
    echo "entrypoint: refusing to start, ADMIN_USERNAME may not contain a colon or newline" >&2
    exit 1
    ;;
esac

# Upstream's own default start room, `/_/global/maps.workadventu.re/starter/map.json` in
# play/src/pusher/enums/EnvironmentVariable.ts, no longer answers: that host times out. This is the
# map upstream's .env.prod.template points self-hosters at instead. Left overridable, because the
# point of shipping map-storage is that an operator replaces this with a map of their own.
export START_ROOM_URL="${START_ROOM_URL:-/_/global/workadventure.github.io/map-starter-kit/office.tmj}"

# The volume. maps/ is map-storage's STORAGE_DIRECTORY and holds everything the map editor saves;
# redis/ holds the Scripting API's variables, which are the only other thing here that outlives a
# restart.
mkdir -p /data/maps /data/redis /run/workadventure /var/log/nginx

# Regenerated every boot so rotating the credentials takes effect on restart.
# On stdin, not argv, to keep the password out of the process list. printf, not sed: the username
# is operator-chosen, and sed would reparse its metacharacters.
PASSWORD_HASH="$(printf '%s' "$ADMIN_PASSWORD" | openssl passwd -apr1 -stdin)"
printf '%s:%s\n' "$ADMIN_USERNAME" "$PASSWORD_HASH" > /run/workadventure/htpasswd
# nginx workers run as www-data and read this file; it is password-equivalent, so nothing else may.
chown www-data:www-data /run/workadventure/htpasswd
chmod 400 /run/workadventure/htpasswd

# Belt to pipefail's braces: a truncated hash would gate nothing and still look like a file.
if [ "$(cut -d: -f1 /run/workadventure/htpasswd)" != "$ADMIN_USERNAME" ] \
    || ! grep -q ':\$apr1\$' /run/workadventure/htpasswd; then
    echo "entrypoint: refusing to start, htpasswd does not hold the user and an apr1 hash" >&2
    exit 1
fi
unset PASSWORD_HASH

# The credential nginx accepts on the game's WebSocket handshake, for the reason nginx.conf gives:
# no header can be set on `new WebSocket()`. Derived from both credentials, so a cookie survives a
# restart and dies when either rotates.
GATE_TOKEN="$(printf 'workadventure-gate-v1:%s:%s' "$ADMIN_USERNAME" "$ADMIN_PASSWORD" \
    | openssl dgst -sha256 -r | cut -d' ' -f1)"

# Fail closed: an empty token would land as an empty map key, which is what $gate_upgrade holds for
# every ordinary request, and would read as "no password required" for the whole site.
if [[ ! "$GATE_TOKEN" =~ ^[0-9a-f]{64}$ ]]; then
    echo "entrypoint: refusing to start, gate token is not a sha256 hex digest" >&2
    exit 1
fi

# Rendered into /run, so the shipped template stays the file a reader can trust and the token never
# lands in an image layer. Readable only by root, which is what nginx's master reads it as.
sed "s|__WA_GATE_TOKEN__|$GATE_TOKEN|g" /etc/nginx/nginx.conf.template > /run/workadventure/nginx.conf
chmod 600 /run/workadventure/nginx.conf
if grep -q '__WA_GATE_TOKEN__' /run/workadventure/nginx.conf; then
    echo "entrypoint: refusing to start, gate token placeholder survived rendering" >&2
    exit 1
fi

# Checked before anything is started, so a config nginx will not load exits with nginx's own
# message rather than leaving five node processes up behind a dead port.
nginx -t -c /run/workadventure/nginx.conf

# map-storage's basic strategy, turned on by ENABLE_BASIC_AUTHENTICATION in the manifest, which
# says why. One pair for both gates: the browser already holds these for nginx and sends them on,
# and nginx forwards the header rather than clearing it.
export AUTHENTICATION_USER="$ADMIN_USERNAME"
export AUTHENTICATION_PASSWORD="$ADMIN_PASSWORD"

# Nothing below needs the plaintext, and the three node apps read it only as the two lines above.
unset ADMIN_USERNAME ADMIN_PASSWORD GATE_TOKEN

stopping=0
pids=()
trap 'stopping=1; kill -TERM "${pids[@]}" 2>/dev/null || true' TERM INT

# Scripting API variables. appendonly off and a save window, because this is a cache of game state
# rather than a system of record, and an fsync per write on a sleeping office buys nothing.
redis-server \
    --bind 127.0.0.1 --port 6379 \
    --dir /data/redis --save 60 1 --appendonly no \
    --daemonize no --loglevel notice &
pids+=($!)

# Favicons for websites opened inside the game. ADDRESS keeps it off every other interface; the
# platform injects a PORT of its own for the routed port, which this would otherwise pick up.
ADDRESS=127.0.0.1 PORT=8082 /usr/local/bin/iconserver &
pids+=($!)

# The map store and the map editor's API. Started through tsx directly rather than `npm run start`,
# which would rebuild the Svelte UI on every boot because PATH_PREFIX is set; the Dockerfile built
# it once with the same prefix.
(
    cd /opt/map-storage/map-storage
    exec env ESBK_TSCONFIG_PATH=tsconfig-node.json /usr/local/bin/wa-tsx ./src/index.ts
) &
pids+=($!)

# The game server. play and map-storage both reach it over gRPC on 127.0.0.1:50051.
(
    cd /opt/back/back
    exec /usr/local/bin/wa-tsx src/server.ts
) &
pids+=($!)

# The pusher and the front: two listeners, 3100 for HTTP and 3101 for the game's WebSocket.
(
    cd /usr/src/play
    exec env TSX_TSCONFIG_PATH=tsconfig-pusher.json /usr/local/bin/wa-tsx ./src/server.ts
) &
play_pid=$!
pids+=("$play_pid")

# nginx takes the routed port only once play answers on loopback, and this order is load-bearing
# twice over. The manifest's `healthcheck: /ping` proxies to play, so binding first would make the
# gate see a 502 rather than a 200 and burn its whole window; and on every wake from zero the
# platform's router waits for this port to open, where a port bound ahead of its upstream turns a
# held request into a failed one.
# /dev/tcp is bash's own, so this needs no curl or nc. Bounded on purpose: a pusher that never
# listens must fail the deploy rather than hang it.
listening=0
for _ in $(seq 1 90); do
    if (exec 3<>/dev/tcp/127.0.0.1/3100) 2>/dev/null; then
        listening=1
        break
    fi
    if ! kill -0 "$play_pid" 2>/dev/null; then
        echo "entrypoint: play exited before it listened on 127.0.0.1:3100" >&2
        exit 1
    fi
    sleep 1
done
if [ "$listening" != 1 ]; then
    echo "entrypoint: play did not listen on 127.0.0.1:3100 within 90s" >&2
    kill -TERM "${pids[@]}" 2>/dev/null || true
    exit 1
fi

nginx -c /run/workadventure/nginx.conf -g 'daemon off;' &
pids+=($!)

# Whichever process exits first takes the container with it. A dead nginx would otherwise leave the
# machine up behind an unreachable URL, which reads as a mystery timeout rather than a failure, and
# a dead back would leave the game page loading forever behind a healthy /ping.
status=0
wait -n || status=$?
kill -TERM "${pids[@]}" 2>/dev/null || true
wait || true

# A signal is an orderly stop, so only a child dying on its own is a failure. Anything else exits
# non-zero, including a process that managed to exit 0: the restart policy is on-failure, so a
# clean exit here would leave the machine running with nothing listening on it.
if [ "$stopping" = 1 ]; then exit 0; fi
[ "$status" -ne 0 ] || status=1
exit "$status"
