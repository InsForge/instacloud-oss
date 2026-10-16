#!/bin/bash
set -euo pipefail

# No fallback on purpose: the manifest declares both required with no default, so the platform
# always supplies them; a missing one means the image was started some other way, and inventing
# `admin` there would hand an editor that writes files to whoever finds the URL.
: "${ADMIN_USERNAME:?ADMIN_USERNAME is required}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

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

cd /opt/open-slide

stopping=0
trap 'stopping=1; kill -TERM "${gate_pid:-}" 2>/dev/null || true' TERM INT

# The InstaCloud sign-in page holds the routed port and checks both credentials, and the dev server
# listens on loopback only, so the gate is the only way in (gate/README.md).
# It passes Host and Origin through untouched, because the dev server compares the two itself on
# every write and refuses a cross-site one: that comparison is the CSRF defence for /__edit,
# /__slides, /__assets and /__comments. It takes the routed port only once the dev server answers,
# because the manifest's `healthcheck: /` is satisfied by the gate's own 401: bound any earlier, a
# deploy would report healthy, and a wake from zero would answer, while every request got a 502
# (measured with the nginx this replaced: up 6s ahead of Vite). Bounded at 60s, so a dev server that
# never listens fails the deploy rather than hanging it past the health timeout. The dev server gets
# neither credential in its environment, and supervises a child of its own, so the editor's in-app
# restart replaces that child and never reaches the `wait` below.
node /usr/local/lib/insta-gate.mjs --name open-slide --port 8080 --upstream-port 5173 \
    --ready-timeout 60 -- ./node_modules/.bin/open-slide dev --host 127.0.0.1 &
gate_pid=$!

# The gate exits when the dev server does, with its status. A signal is an orderly stop, so only an
# exit on its own is a failure, and anything else exits non-zero, including a dev server that
# managed to exit 0: the restart policy is on-failure, so a clean exit here would leave the machine
# running with nothing listening on it.
status=0
wait "$gate_pid" || status=$?
if [ "$stopping" = 1 ]; then
    wait "$gate_pid" || true
    exit 0
fi
[ "$status" -ne 0 ] || status=1
exit "$status"
