#!/bin/bash
set -e

# No fallback on purpose: the manifest declares both required with no default or generator, so the
# platform always supplies them; inventing one here would hand the agent to whoever finds the URL.
: "${ADMIN_USERNAME:?ADMIN_USERNAME is required}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

# Two different failures, both silent without this. A colon can never reach the dashboard: basic
# auth sends `user:password` and the server splits on the FIRST one, so `alice:ops` is unpresentable
# at the browser prompt while the deploy goes green (the health probe fetches /api/status, which is
# not behind the auth). A leading dash is read as an option by `hermes config set`, which takes this
# as argv, and kills the container on a CLI error naming neither the variable nor the typo.
case "$ADMIN_USERNAME" in *:*|-*|*$'\n'*)
    echo "entrypoint: refusing to start, ADMIN_USERNAME may not contain a colon or a newline, or start with a dash" >&2
    exit 1
esac

export HERMES_HOME="${HERMES_HOME:-/data/.hermes}"
mkdir -p "$HERMES_HOME"

# Upstream refuses a non-loopback dashboard bind with no auth provider registered
# (`--insecure` is a documented no-op), so the credential has to exist first.
# `config set` rather than writing config.yaml: the volume survives reboots, and an
# appended YAML block would pile up a copy per boot.
#
# Only when the credential CHANGED. Hashing the password and the two `config set`
# calls are three full boots of the hermes CLI, ~6-8 s of every wake on a 4 vCPU VM,
# and the result is already in config.yaml on the volume from the last boot. So first
# check the supplied credential against what config.yaml holds: the username must
# match and the password must verify against the stored scrypt hash, re-derived with
# the stored parameters and compared in constant time. That check is stdlib Python
# (hashlib, base64, hmac) and takes a fraction of a second; it stores NOTHING new --
# no marker, no second verifier -- the only secret material on the volume stays the
# salted scrypt hash the dashboard keeps anyway. A rotated secret fails the check
# and takes the full path once. Any doubt (no config.yaml, no hash, an unparseable
# hash, a Python error) also takes the full path: the fast path is only ever taken
# on a positive verification.
credential_current() {
  [ -f "$HERMES_HOME/config.yaml" ] || return 1
  ADMIN_USERNAME="$ADMIN_USERNAME" ADMIN_PASSWORD="$ADMIN_PASSWORD" HERMES_CONFIG="$HERMES_HOME/config.yaml" python3 - <<'PY'
import base64, hashlib, hmac, os, sys
import yaml
cfg = yaml.safe_load(open(os.environ["HERMES_CONFIG"])) or {}
auth = ((cfg.get("dashboard") or {}).get("basic_auth") or {})
if auth.get("username") != os.environ["ADMIN_USERNAME"]:
    sys.exit(1)
stored = auth.get("password_hash") or ""
kind, n, r, p, salt, digest = stored.split("$", 5)
if kind != "scrypt":
    sys.exit(1)
salt, digest = base64.b64decode(salt), base64.b64decode(digest)
got = hashlib.scrypt(os.environ["ADMIN_PASSWORD"].encode(), salt=salt, n=int(n), r=int(r), p=int(p), dklen=len(digest), maxmem=0)
sys.exit(0 if hmac.compare_digest(got, digest) else 1)
PY
}
if credential_current 2>/dev/null; then
  echo "entrypoint: dashboard credential unchanged since the last boot; skipping auth bootstrap"
else
  hash="$(cd /opt/hermes && python3 -c 'import sys; from plugins.dashboard_auth.basic import hash_password; print(hash_password(sys.argv[1]))' "$ADMIN_PASSWORD")"
  # Output suppressed: `config set` echoes the value, and the hash would land in the
  # log tail the console shows.
  hermes config set --force dashboard.basic_auth.username "$ADMIN_USERNAME" >/dev/null
  hermes config set --force dashboard.basic_auth.password_hash "$hash" >/dev/null
fi

# The gateway runs as the s6-supervised gateway-default service, NOT as this script's
# child. The platform hands the image PID 1, so s6-overlay is live (a 2.1.x comment
# claiming Fly skips it was wrong: PID 1 on a deployed machine is s6-svscan) and
# `hermes gateway start` dispatches to s6, bringing the slot up. That slot is the same
# one the dashboard's Channels-page "Restart gateway" and System-page buttons drive
# through s6-svc, so channel changes apply repeatedly and a crashed gateway is
# respawned by s6, both upstream-owned behaviors. In the 2.1.x layout the gateway was
# the main process instead, and those buttons fought it: a restart either exited the
# container or left a detached gateway the dashboard could no longer manage.
# Zero configured channels is fine: the gateway idles and browser chat still works.
#
# First boot ONLY: upstream's boot reconciliation replays the operator's persisted
# intent from ${HERMES_HOME}/gateway_state.json (running comes back up, an explicit
# dashboard Stop stays down), and s6 lifecycle commands write that file. Starting
# unconditionally here would overwrite a persisted Stop on every container restart,
# silently reconnecting messaging channels the operator turned off. The seed exists so
# a fresh deploy connects its deploy-time channel variables without a dashboard visit.
# Non-fatal on purpose: in a runtime without s6 this prints guidance and exits 0, the
# dashboard still serves, and channels can wait for a start from the System page.
if [ ! -f "${HERMES_HOME}/gateway_state.json" ]; then
  hermes gateway start || echo "entrypoint: gateway start failed; start it from the dashboard's System page" >&2
fi

# The dashboard is the main process of the s6 CMD service: the /api/status healthcheck
# tracks the UI users actually reach, and gateway restarts never touch it. If it dies,
# s6 reruns this script, which is idempotent.
# --skip-build serves the dist baked into the image instead of running npm at boot.
exec hermes dashboard --host 0.0.0.0 --port "${HERMES_DASHBOARD_PORT:-8080}" --no-open --skip-build
