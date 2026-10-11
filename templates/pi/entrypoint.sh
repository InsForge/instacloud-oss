#!/bin/bash
set -e
mkdir -p "$HOME"
cd "$HOME"
# Neither gets a fallback on purpose. The manifest declares both required with no default, so the
# platform always supplies them; a missing one means the image was started some other way, and
# inventing `admin` there would hand a root shell to whoever finds the URL.
: "${ADMIN_USERNAME:?ADMIN_USERNAME is required}" "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"
# A GH_TOKEN from the deploy form signs in gh, but git reads neither it nor gh's store, and no
# committer identity exists, so a box deployed with a token still could not push or even commit.
# `gh auth login` does the first of those by asking; the second it never does, and an agent's first
# commit is where that shows up. Both are derivable from the token, so do them here.
if [ -n "${GH_TOKEN:-}" ]; then
  gh auth setup-git || echo "entrypoint: gh auth setup-git failed, git will ask for credentials" >&2
  if ! git config --global --get user.email >/dev/null 2>&1; then
    # The noreply address is the one GitHub accepts for an account whose email is private, so a
    # push is not rejected for it. A slow or unreachable API must not hold the boot.
    if identity=$(timeout 10 gh api user --jq '"\(.name // .login)\t\(.id)+\(.login)@users.noreply.github.com"' 2>/dev/null); then
      git config --global user.name "${identity%%$'\t'*}"
      git config --global user.email "${identity##*$'\t'}"
    else
      echo "entrypoint: no GitHub identity for this token, set user.name and user.email yourself" >&2
    fi
  fi
fi

# The InstaCloud sign-in page holds the routed port and checks both. ttyd listens on loopback only,
# with no credential of its own, so the gate is the only way in (plans/2026-10-08-ttyd-login-gate-spec.md).
# ttyd kills its child when a tab closes, so every tab attaches to one tmux session that outlives it.
# tmux takes the mouse, so a Mac needs Option+drag to select text, which xterm.js leaves off by default.
exec node /usr/local/lib/insta-gate.mjs --name pi -- \
  ttyd -i lo -p 7682 -W -t macOptionClickForcesSelection=true tmux -u new-session -A -s main
