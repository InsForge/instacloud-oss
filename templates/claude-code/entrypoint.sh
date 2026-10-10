#!/bin/bash
set -e
mkdir -p "$HOME"
cd "$HOME"
# Neither gets a fallback on purpose. The manifest declares both required with no default, so the
# platform always supplies them; a missing one means the image was started some other way, and
# inventing `admin` there would hand a root shell to whoever finds the URL.
: "${ADMIN_USERNAME:?ADMIN_USERNAME is required}" "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"
# The InstaCloud sign-in page holds the routed port and checks both. ttyd listens on loopback only,
# with no credential of its own, so the gate is the only way in (plans/2026-10-08-ttyd-login-gate-spec.md).
# ttyd kills its child when a tab closes, so every tab attaches to one tmux session that outlives it.
# tmux takes the mouse, so a Mac needs Option+drag to select text, which xterm.js leaves off by default.
exec node /usr/local/lib/insta-gate.mjs --name claude-code -- \
  ttyd -i lo -p 7682 -W -t macOptionClickForcesSelection=true tmux -u new-session -A -s main
