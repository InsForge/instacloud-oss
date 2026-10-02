#!/bin/bash
# pipefail is load-bearing: without it a failed `openssl passwd` still writes a usable-looking
# htpasswd, and the platform's `healthcheck: /` reads the resulting blanket 401 as healthy.
set -euo pipefail

# No fallback on purpose: the manifest declares both required with no default, so the platform
# always supplies them; a missing one means the image was started some other way, and inventing
# `admin` there would hand an editor that writes files to whoever finds the URL.
: "${ADMIN_USERNAME:?ADMIN_USERNAME is required}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

# htpasswd's field separator; a username carrying one would smuggle in a second, empty credential.
case "$ADMIN_USERNAME" in *:* | *$'\n'*)
    echo "entrypoint: refusing to start, ADMIN_USERNAME may not contain a colon or newline" >&2
    exit 1
    ;;
esac

# First boot on an empty volume gets the scaffolded deck and the two empty trees. Copied, not
# symlinked: from here on this is the operator's content, and a later image must not move it.
# Each directory is tested on its own, so deleting one from the UI's reach does not re-seed the
# others, and an operator who emptied slides/ on purpose gets it back rather than a broken page.
mkdir -p /data
for dir in slides themes assets; do
    if [ ! -e "/data/$dir" ]; then
        cp -a "/opt/open-slide/seed/$dir" "/data/$dir"
    fi
done

# A deck is ordinary React: `slides/<id>/index.tsx` imports @open-slide/core, react and
# react/jsx-dev-runtime by bare specifier, and Vite resolves those by walking up from the FILE, not
# from the workspace. With the decks on the volume that walk is /data/slides -> /data -> /, none of
# which holds a node_modules, and every deck fails to transform with "Failed to resolve import
# @open-slide/core" while the deck browser around it renders fine. This is the walk's one rung:
# the realpath is the workspace's own tree, so react stays a single copy and `dedupe` still holds.
# Relinked every boot so it follows the image rather than whatever an older one left behind, but
# only when it is this link: a real directory there is an operator's own install, and -n would
# write the link INSIDE it.
if [ -L /data/node_modules ] || [ ! -e /data/node_modules ]; then
    ln -sfn /opt/open-slide/node_modules /data/node_modules
fi

mkdir -p /run/open-slide

# Regenerated every boot so rotating the credentials takes effect on restart.
# On stdin, not argv, to keep the password out of the process list. printf, not sed: the username
# is operator-chosen, and sed would reparse its metacharacters.
PASSWORD_HASH="$(printf '%s' "$ADMIN_PASSWORD" | openssl passwd -apr1 -stdin)"
printf '%s:%s\n' "$ADMIN_USERNAME" "$PASSWORD_HASH" > /run/open-slide/htpasswd
# nginx workers run as www-data and read this file; it is password-equivalent, so nothing else may.
chown www-data:www-data /run/open-slide/htpasswd
chmod 400 /run/open-slide/htpasswd

# Belt to pipefail's braces: a truncated hash would gate nothing and still look like a file.
if [ "$(cut -d: -f1 /run/open-slide/htpasswd)" != "$ADMIN_USERNAME" ] || ! grep -q ':\$apr1\$' /run/open-slide/htpasswd; then
    echo "entrypoint: refusing to start, htpasswd does not hold the user and an apr1 hash" >&2
    exit 1
fi
unset PASSWORD_HASH

# The credential nginx accepts on a WebSocket handshake, for the reason nginx.conf gives: no header
# can be set on `new WebSocket()`, and not every engine attaches the basic credentials. Derived
# from both credentials, so a cookie survives a restart and dies when either rotates.
GATE_TOKEN="$(printf 'open-slide-gate-v1:%s:%s' "$ADMIN_USERNAME" "$ADMIN_PASSWORD" | openssl dgst -sha256 -r | cut -d' ' -f1)"

# Fail closed: an empty token would land as an empty map key, which is what $gate_upgrade holds for
# every ordinary request, and would read as "no password required" for the whole site.
if [[ ! "$GATE_TOKEN" =~ ^[0-9a-f]{64}$ ]]; then
    echo "entrypoint: refusing to start, gate token is not a sha256 hex digest" >&2
    exit 1
fi

# Rendered into /run, so the shipped template stays the file a reader can trust and the token never
# lands in an image layer. Readable only by root, which is what nginx's master reads it as: it is
# password-equivalent.
sed "s|__OPEN_SLIDE_GATE_TOKEN__|$GATE_TOKEN|g" /etc/nginx/nginx.conf.template > /run/open-slide/nginx.conf
chmod 600 /run/open-slide/nginx.conf
if grep -q '__OPEN_SLIDE_GATE_TOKEN__' /run/open-slide/nginx.conf; then
    echo "entrypoint: refusing to start, gate token placeholder survived rendering" >&2
    exit 1
fi

# Checked before it is started, so a config nginx will not load exits with nginx's own message
# rather than leaving the dev server running behind a dead port.
nginx -t -c /run/open-slide/nginx.conf

# Neither process needs the plaintext from here on.
unset ADMIN_USERNAME ADMIN_PASSWORD

cd /opt/open-slide

stopping=0
trap 'stopping=1; kill -TERM "${dev_pid:-}" "${nginx_pid:-}" 2>/dev/null || true' TERM INT

# --host 127.0.0.1 because nginx is the only process on the routed port. The dev server supervises
# a child of its own, so the editor's in-app restart replaces that child and never reaches the
# `wait` below.
./node_modules/.bin/open-slide dev --host 127.0.0.1 &
dev_pid=$!
nginx -c /run/open-slide/nginx.conf -g 'daemon off;' &
nginx_pid=$!

# Whichever half exits first takes the container with it. A dead nginx would otherwise leave the
# machine up behind an unreachable URL, which reads as a mystery timeout rather than a failure, and
# a dead dev server would leave nginx answering 502 behind a process that is still alive.
status=0
wait -n || status=$?
kill -TERM "$dev_pid" "$nginx_pid" 2>/dev/null || true
wait || true

# A signal is an orderly stop, so only a child dying on its own is a failure. Anything else exits
# non-zero, including a half that managed to exit 0: the restart policy is on-failure, so a clean
# exit here would leave the machine running with nothing listening on it.
if [ "$stopping" = 1 ]; then exit 0; fi
[ "$status" -ne 0 ] || status=1
exit "$status"
