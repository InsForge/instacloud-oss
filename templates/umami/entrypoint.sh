#!/bin/sh
# Upstream's scripts/start-docker.sh with two steps added in front of the server.
#
# Everything upstream's script does is still done here and in the same order, including the `exec`
# that leaves a single `node server.js` as PID 1 and the PATH that lets check-db.js find the prisma
# CLI in node_modules/.bin.
set -e
export PATH="/app/node_modules/.bin:$PATH"
cd /app

if [ -z "${ADMIN_USERNAME}" ] || [ -z "${ADMIN_PASSWORD}" ]; then
    echo "$0: ADMIN_USERNAME and ADMIN_PASSWORD are both required." >&2
    echo "$0: without them the admin account would stay on the password upstream's first" >&2
    echo "$0: migration seeds, which is published in the repository." >&2
    exit 1
fi

# Umami wants exactly 64 hex characters here (src/lib/two-factor/crypto.ts), and the platform's one
# generator family emits base64url, so no `generated:` entry can produce a valid key. Derive one
# from APP_SECRET instead: different on every deployment, and stable across restarts, which matters
# because this key decrypts the TOTP secrets already in the database. A value set by hand in the
# console wins over the derived one.
if [ -z "${TWO_FACTOR_ENCRYPTION_KEY}" ]; then
    TWO_FACTOR_ENCRYPTION_KEY=$(printf '%s' "umami-two-factor:${APP_SECRET}" | sha256sum | cut -c1-64)
    export TWO_FACTOR_ENCRYPTION_KEY
fi

node scripts/check-db.js
node scripts/update-tracker.js
node /insta/set-admin.cjs

exec node server.js
