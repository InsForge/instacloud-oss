#!/bin/bash
# pipefail is load-bearing: without it a failed `openssl passwd` still writes a usable-looking
# htpasswd, and the platform's `healthcheck: /` reads the resulting blanket 401 as healthy.
set -euo pipefail

export HOME="${HOME:-/data/home}"
export DSH_HOME="${DSH_HOME:-/data/dsh}"

# A volume the image did not create arrives with whatever ownership it already had. Fly happens to
# chown a fresh one to the image's USER, but that is a platform behaviour we would be depending on,
# not something this image guarantees: a volume written by 0.1.0 (which ran as root), a restored
# backup, or a bind mount all arrive root-owned, and `mkdir $HOME/workspace` then fails before
# nginx binds anything. So the image owns its own precondition instead of assuming the platform
# arranged it. The same pattern the official postgres and mysql images use.
#
# The privileges are given up immediately afterwards and cannot be taken back: --inh-caps=-all
# empties the inheritable set, so dsh and every shell the model spawns run as `node` with no
# CAP_SYS_ADMIN, which is what forces bwrap through a user namespace and makes its read-only binds
# stick. See the USER note in the Dockerfile.
if [ "$(id -u)" = "0" ]; then
    want="$(id -u node):$(id -g node)"
    # /data/workspace is 0.1.0's, and nothing reads it now. Chowned rather than deleted: it is not
    # this script's call to destroy whatever an operator may have put there.
    for dir in /data "$HOME" "$DSH_HOME" /data/workspace; do
        if [ -e "$dir" ] && [ "$(stat -c '%u:%g' "$dir")" != "$want" ]; then
            chown -R node:node "$dir"
        fi
    done
    exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all "$0" "$@"
fi

# Still root here means the drop above did not happen -- someone removed it, or a future runtime
# entered by a path that skips it. bwrap would then build its read-only binds without a user
# namespace, the kernel would leave them unlocked, and one `mount -o remount,rw` from inside would
# undo the whole boundary while the sandbox still looked present. Refuse instead: the property is
# worth more as a check the script enforces than as a comment someone has to have read.
if [ "$(id -u)" = "0" ]; then
    echo "entrypoint: refusing to start as root, the agent sandbox does not contain root" >&2
    exit 1
fi

# No fallback on purpose: the manifest declares both required with no default, so the platform
# always supplies them; inventing one here would hand the agent to whoever finds the URL.
: "${ADMIN_USERNAME:?ADMIN_USERNAME is required}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

# htpasswd's field separator; a username carrying one would smuggle in a second, empty credential.
case "$ADMIN_USERNAME" in *:*|*$'\n'*)
    echo "entrypoint: refusing to start, ADMIN_USERNAME may not contain a colon or newline" >&2
    exit 1
esac

export HOME="${HOME:-/data/home}"
export DSH_HOME="${DSH_HOME:-/data/dsh}"

# $HOME/workspace, not /data/workspace: the workspace is chosen per session from a picker rooted at
# $HOME, so a sibling of $HOME can never be selected. This one is a ready-made option in that list;
# the operator may make others beside it. /tmp/nginx holds the temp dirs nginx needs as non-root.
mkdir -p "$HOME" "$DSH_HOME" "$HOME/workspace" /run/dsh /tmp/nginx

# Regenerated every boot so rotating the credentials takes effect on restart.
# On stdin, not argv, to keep the password out of the process list. printf, not sed: the
# username is operator-chosen, and sed would reparse its metacharacters.
PASSWORD_HASH="$(printf '%s' "$ADMIN_PASSWORD" | openssl passwd -apr1 -stdin)"
printf '%s:%s\n' "$ADMIN_USERNAME" "$PASSWORD_HASH" > /run/dsh/htpasswd
# 600, and no chown: nginx now runs as the same unprivileged uid that wrote this, so the file needs
# no group to share it with, and an unprivileged process cannot give a file away.
chmod 600 /run/dsh/htpasswd

# Belt to pipefail's braces: a truncated hash would gate nothing and still look like a file.
if [ "$(cut -d: -f1 /run/dsh/htpasswd)" != "$ADMIN_USERNAME" ] || ! grep -q ':\$apr1\$' /run/dsh/htpasswd; then
    echo "entrypoint: refusing to start, htpasswd does not hold the user and an apr1 hash" >&2
    exit 1
fi
unset PASSWORD_HASH

# The credential nginx accepts on a WebSocket handshake, for the reason nginx.conf gives: no
# header can be set on `new WebSocket()`, and not every engine attaches the basic credentials.
# Derived from both credentials, so a cookie survives a restart and dies when either rotates.
GATE_TOKEN="$(printf 'dsh-gate-cookie-v1:%s:%s' "$ADMIN_USERNAME" "$ADMIN_PASSWORD" | openssl dgst -sha256 -r | cut -d' ' -f1)"

# Fail closed: an empty token would land as an empty map key, which is what $gate_upgrade holds
# for every ordinary request, and would read as "no password required" for the whole site.
if [[ ! "$GATE_TOKEN" =~ ^[0-9a-f]{64}$ ]]; then
    echo "entrypoint: refusing to start, gate token is not a sha256 hex digest" >&2
    exit 1
fi

# Rendered into /run, so the shipped template stays the file a reader can trust and the token
# never lands in an image layer. Readable only by the uid that runs both processes: it is
# password-equivalent.
sed "s|__DSH_GATE_TOKEN__|$GATE_TOKEN|g" /etc/nginx/nginx.conf.template > /run/dsh/nginx.conf
chmod 600 /run/dsh/nginx.conf
if grep -q '__DSH_GATE_TOKEN__' /run/dsh/nginx.conf; then
    echo "entrypoint: refusing to start, gate token placeholder survived rendering" >&2
    exit 1
fi

# Neither process needs the plaintext from here on, and dsh runs shell commands the model chooses,
# so anything it spawns would otherwise inherit the gate credentials.
unset ADMIN_USERNAME ADMIN_PASSWORD

# Checked before it is started, so a config nginx will not load exits with nginx's own message
# rather than leaving dsh running behind a dead port.
nginx -t -c /run/dsh/nginx.conf

cd "$HOME"

# 127.0.0.1 is upstream's rule, not a workaround: `--host 0.0.0.0` is refused by design because
# the UI drives an agent that runs commands and has no auth (bundle/web-app/src/startup.ts).
nginx -c /run/dsh/nginx.conf -g 'daemon off;' &
nginx_pid=$!
dsh web --host 127.0.0.1 --port 3080 --no-open &
dsh_pid=$!

# Both halves are fatal. Backgrounding nginx under `exec dsh` used to mean a dead nginx left the
# container up with an unreachable URL, which reads as a mystery timeout instead of a failure.
stopping=""
trap 'stopping=1; kill -TERM "$nginx_pid" "$dsh_pid" 2>/dev/null || true' TERM INT
wait -n || true

# A signal is an orderly stop, so only a child dying on its own is a failure.
if [[ -n "$stopping" ]]; then
    exit 0
fi
echo "entrypoint: nginx or dsh exited, stopping the container" >&2
exit 1
