#!/bin/bash
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

export HOME="${HOME:-/data/home}"
export DSH_HOME="${DSH_HOME:-/data/dsh}"

# $HOME/workspace, not /data/workspace: the workspace is chosen per session from a picker rooted at
# $HOME, so a sibling of $HOME can never be selected. This one is a ready-made option in that list;
# the operator may make others beside it. /tmp/nginx holds the temp dirs nginx needs as non-root.
mkdir -p "$HOME" "$DSH_HOME" "$HOME/workspace" /run/dsh /tmp/nginx

cd "$HOME"

# The InstaCloud sign-in page (gate/README.md) holds the routed port and checks both credentials,
# in front of an nginx on loopback that normalizes Host and Origin. It takes the port once nginx
# answers and exits when nginx does, and nginx gets neither credential.
node /usr/local/lib/insta-gate.mjs --name dsh --port 8080 --upstream-port 8081 -- \
    nginx -c /etc/nginx/nginx.conf -g 'daemon off;' &
gate_pid=$!

# dsh runs shell commands the model chooses, so anything it spawns would otherwise inherit the
# sign-in credentials. The gate already holds its own copy.
unset ADMIN_USERNAME ADMIN_PASSWORD

# 127.0.0.1 is upstream's rule, not a workaround: `--host 0.0.0.0` is refused by design because
# the UI drives an agent that runs commands and has no auth (bundle/web-app/src/startup.ts).
dsh web --host 127.0.0.1 --port 3080 --no-open &
dsh_pid=$!

# Both halves are fatal. Backgrounding the front under `exec dsh` used to mean a dead nginx left
# the container up with an unreachable URL, which reads as a mystery timeout instead of a failure.
stopping=""
trap 'stopping=1; kill -TERM "$gate_pid" "$dsh_pid" 2>/dev/null || true' TERM INT
wait -n || true

# A signal is an orderly stop, so only a child dying on its own is a failure.
if [[ -n "$stopping" ]]; then
    exit 0
fi
echo "entrypoint: the gate or dsh exited, stopping the container" >&2
exit 1
