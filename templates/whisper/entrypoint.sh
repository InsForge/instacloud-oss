#!/bin/bash
# pipefail is load-bearing here for the same reason it is in dsh: a half-failed credential setup
# must not leave ttyd running behind a `healthcheck: /` that reads its blanket 401 as healthy.
set -euo pipefail

export HOME="${HOME:-/data/home}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/data/cache}"

# The volume mounts at /data and this image runs as root, so these are creates, not chowns: there
# is no uid drop anywhere in this container and nothing to hit EACCES on.
# audio/ and transcripts/ are made rather than left to the user because `--output_dir` has to
# point somewhere on the volume for a transcript to survive a restart, and an empty pair of
# directories is the cheapest way to say where.
mkdir -p "$HOME" "$HOME/audio" "$HOME/transcripts" "$XDG_CACHE_HOME/whisper"

# Seed the baked models onto the volume, once. Copied instead of symlinked so that `whisper` can
# verify and, if it ever needs to, replace them: it re-derives each model's SHA-256 from the
# download URL and rewrites the file when it does not match, which a read-only symlink into the
# image would turn into a permission error on a path the user cannot fix.
# Only when absent: after the first boot these are the volume's, and a later image with a
# different baked set must not silently overwrite what the running instance has been using.
for model in tiny.pt base.pt; do
    if [ ! -f "$XDG_CACHE_HOME/whisper/$model" ] && [ -f "/opt/whisper-models/$model" ]; then
        cp "/opt/whisper-models/$model" "$XDG_CACHE_HOME/whisper/$model"
        echo "entrypoint: seeded $model into $XDG_CACHE_HOME/whisper"
    fi
done

# Neither gets a fallback on purpose. The manifest declares both required with no default, so the
# platform always supplies them; a missing one means the image was started some other way, and
# inventing `admin` there would hand a root shell to whoever finds the URL.
CRED="${ADMIN_USERNAME:?ADMIN_USERNAME is required}:${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

# ttyd splits -c on the FIRST colon, so a colon in the username silently moves the boundary and
# the operator ends up with a credential they did not choose. Refuse instead of guessing.
case "$ADMIN_USERNAME" in *:*)
    echo "entrypoint: refusing to start, ADMIN_USERNAME may not contain a colon" >&2
    exit 1
esac

# ttyd 1.7.7 quietly stops matching the credential once "user:pass" passes 186 bytes. It starts
# normally and then answers 401 to everyone, the owner included, logging nothing; the health check
# reads that 401 as alive, so the deploy reports success and the terminal is unreachable for good.
# Fail loudly instead.
# Bytes, not characters: ${#CRED} counts characters, which differ under a non-C locale.
CRED_BYTES=$(printf '%s' "$CRED" | wc -c)
if [ "$CRED_BYTES" -gt 186 ]; then
  echo "ADMIN_USERNAME:ADMIN_PASSWORD is $CRED_BYTES bytes; ttyd accepts at most 186" >&2
  exit 1
fi

cd "$HOME"

# `bash -l`, not `bash`: a login shell is what sources /etc/profile.d, where the usage banner
# lives. Without it the user lands on a bare prompt in a browser tab with nothing telling them
# the model cache is warm, where to put audio, or that a sample file is already on disk.
exec ttyd -p 7681 -W -c "$CRED" bash -l
