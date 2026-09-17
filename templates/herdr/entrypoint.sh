#!/bin/bash
set -e

# The volume arrives empty on the first deploy, so nothing has created $HOME yet. npm creates its
# own global prefix under here when it first needs it; this is only about the directory both it and
# herdr expect to already exist.
mkdir -p "$HOME"
cd "$HOME"

# Written once, on the first boot that finds no config, and never touched again: from then on it is
# the operator's file to edit from inside the terminal, and herdr's own settings UI writes here too.
CONFIG="$HOME/.config/herdr/config.toml"
if [ ! -e "$CONFIG" ]; then
    mkdir -p "$(dirname "$CONFIG")"
    cat > "$CONFIG" <<'TOML'
# herdr configuration, seeded by the InstaCloud template on first boot. Yours to edit.
# Full reference: https://herdr.dev/docs/configuration/

[update]
# herdr's background check would offer an update this box cannot keep. `herdr update` rewrites
# /usr/local/bin/herdr, which lives in the image layer rather than on the volume, so a restart
# throws the new binary away and the banner comes back. The image pins 0.9.1; upgrade by deploying
# a newer version of this template. Set this to true if you would rather see the notice anyway.
version_check = false
TOML
fi

# Neither gets a fallback on purpose. The manifest declares both required with no default, so the
# platform always supplies them; a missing one means the image was started some other way, and
# inventing `admin` there would hand a root shell to whoever finds the URL.
CRED="${ADMIN_USERNAME:?ADMIN_USERNAME is required}:${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

# ttyd splits -c on the FIRST colon, so a username carrying one would silently move the tail of it
# into the password and nobody could sign in with what they typed into the deploy form.
case "$ADMIN_USERNAME" in *:*)
    echo "entrypoint: refusing to start, ADMIN_USERNAME may not contain a colon" >&2
    exit 1
esac

# ttyd 1.7.7 quietly stops matching the credential once "user:pass" passes 186 bytes. It starts
# normally and then answers 401 to everyone, the owner included, logging nothing; the health check
# reads that 401 as alive, so the deploy reports success and the terminal is unreachable for good.
# Measured against the sibling templates' image: 186 bytes authenticates, 187 does not. Fail loudly.
# Bytes, not characters: ${#CRED} counts characters, which differ under a non-C locale.
CRED_BYTES=$(printf '%s' "$CRED" | wc -c)
if [ "$CRED_BYTES" -gt 186 ]; then
    echo "ADMIN_USERNAME:ADMIN_PASSWORD is $CRED_BYTES bytes; ttyd accepts at most 186" >&2
    exit 1
fi

# ttyd is the long-running process and owns the port; herdr is what it launches per connection.
# That order matters: herdr's client is a TUI that exits on `ctrl+b q`, and a container whose PID 1
# was herdr would stop the moment someone detached.
exec ttyd -p 7681 -W -c "$CRED" /usr/local/bin/herdr-web
