#!/bin/bash
set -e
mkdir -p "$HOME"
cd "$HOME"
# Neither gets a fallback on purpose. The manifest declares both required with no default, so the
# platform always supplies them; a missing one means the image was started some other way, and
# inventing `admin` there would hand a root shell to whoever finds the URL.
: "${ADMIN_USERNAME:?ADMIN_USERNAME is required}" "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

# The CLI reads SUPERSET_API_KEY out of the environment itself, so the key is never on a command
# line. --org is only needed when the key reaches more than one organization; the CLI will not guess.
start_host() {
  if [ -n "${SUPERSET_ORGANIZATION_ID:-}" ]; then
    timeout 90 superset start --daemon --org "$SUPERSET_ORGANIZATION_ID"
  else
    timeout 90 superset start --daemon
  fi
}

# Register this box with the Superset relay when the operator supplied a key, so a restart brings
# the host back without anyone opening the terminal. Deliberately not fatal: a wrong or expired key
# must still leave a usable shell, because that shell is where `superset auth login` is run.
if [ -n "${SUPERSET_API_KEY:-}" ]; then
  echo "entrypoint: SUPERSET_API_KEY is set, registering this machine as a Superset host"
  if start_host; then
    echo "entrypoint: host service running, this machine should appear online in your organization"
  else
    echo "entrypoint: superset start failed; the terminal still works, sign in there with 'superset auth login' and run 'superset start --daemon'" >&2
  fi
else
  echo "entrypoint: no SUPERSET_API_KEY, so no host is registered. Run 'superset auth login' then 'superset start --daemon' in the terminal"
fi

# The InstaCloud sign-in page holds the routed port and checks both. ttyd listens on loopback only,
# with no credential of its own, so the gate is the only way in (plans/2026-10-08-ttyd-login-gate-spec.md).
# ttyd kills its child when a tab closes, so every tab attaches to one tmux session that outlives it.
# tmux takes the mouse, so a Mac needs Option+drag to select text, which xterm.js leaves off by default.
exec node /usr/local/lib/insta-gate.mjs --name superset-sh -- \
  ttyd -i lo -p 7682 -W -t macOptionClickForcesSelection=true tmux -u new-session -A -s main
