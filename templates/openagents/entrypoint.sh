#!/bin/sh
# Upstream bakes its network workspace into the image at /network and starts the server on it.
# That directory is the whole persistence story: openagents.sdk.network builds its WorkspaceManager
# from the path it is started on, and the SQLite event store, per-mod storage, uploaded files and
# logs all land inside it. On this platform the image filesystem is thrown away on every restart,
# so the workspace is seeded onto the volume once and /network is pointed at it.
#
# The same seed step is where the shipped demo credentials are replaced: upstream's network.yaml
# carries SHA-256 hashes whose plaintext is in its repository (the admin group's is "admin"), and
# leaving them would be the same password on every deployment in the world.
set -e

: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"
NETWORK_NAME="${NETWORK_NAME:-OpenAgents Network}"
NETWORK_DISCOVERABLE="${NETWORK_DISCOVERABLE:-false}"
export ADMIN_PASSWORD NETWORK_NAME NETWORK_DISCOVERABLE

WORKSPACE=/data/network

# Seed once. After the first boot the workspace on the volume is the operator's, so a later start
# leaves it alone: Studio can write the config back, and a reseed would undo that.
if [ ! -f "$WORKSPACE/network.yaml" ]; then
  echo "insta: seeding the network workspace into $WORKSPACE"
  mkdir -p "$WORKSPACE"
  cp -a /network/. "$WORKSPACE/"
  python3 - "$WORKSPACE/network.yaml" <<'PY'
import hashlib
import os
import sys

import yaml

path = sys.argv[1]
with open(path) as fh:
    cfg = yaml.safe_load(fh)

net = cfg.setdefault("network", {})
net["name"] = os.environ["NETWORK_NAME"]

# One password for the whole network. requires_password=True is what makes it mandatory: with it
# false, an agent that presents nothing is waved through into the default group.
digest = hashlib.sha256(os.environ["ADMIN_PASSWORD"].encode()).hexdigest()
for group in (net.get("agent_groups") or {}).values():
    group["password_hash"] = digest
net["requires_password"] = True

profile = cfg.setdefault("network_profile", {})
profile["discoverable"] = os.environ["NETWORK_DISCOVERABLE"].strip().lower() in ("1", "true", "yes")
profile["name"] = os.environ["NETWORK_NAME"]

with open(path, "w") as fh:
    yaml.safe_dump(cfg, fh, sort_keys=False, allow_unicode=True)
PY
fi

rm -rf /network
ln -s "$WORKSPACE" /network

exec /app/docker-entrypoint.sh
