#!/bin/bash
set -e
mkdir -p "$HOME"
cd "$HOME"
# Neither gets a fallback on purpose. The manifest declares both required with no default, so the
# platform always supplies them; a missing one means the image was started some other way, and
# inventing `admin` there would hand a root shell to whoever finds the URL.
CRED="${ADMIN_USERNAME:?ADMIN_USERNAME is required}:${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"
# ttyd 1.7.7 quietly stops matching the credential once "user:pass" passes 186 bytes. It starts
# normally and then answers 401 to everyone, the owner included, logging nothing; the health check
# reads that 401 as alive, so the deploy reports success and the terminal is unreachable for good.
# Measured against this image: 186 bytes authenticates, 187 does not. Fail loudly instead.
# Bytes, not characters: ${#CRED} counts characters, which differ under a non-C locale.
CRED_BYTES=$(printf '%s' "$CRED" | wc -c)
if [ "$CRED_BYTES" -gt 186 ]; then
  echo "ADMIN_USERNAME:ADMIN_PASSWORD is $CRED_BYTES bytes; ttyd accepts at most 186" >&2
  exit 1
fi
exec ttyd -p 7681 -W -c "$CRED" bash
