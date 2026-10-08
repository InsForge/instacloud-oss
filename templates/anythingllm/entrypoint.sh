#!/bin/bash
set -e

# No fallback on purpose: the manifest declares it required with no default and no generator, so
# the platform always supplies it. Inventing one here would publish an unlocked instance, because
# upstream reads a missing AUTH_TOKEN as "this install wants no password" rather than as an error.
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

# Single-user password mode. Upstream's env name is AUTH_TOKEN; the manifest asks for the house
# name so the deploy form reads the way every other template's does. JWT_SECRET arrives from the
# manifest's generated block, and both have to be set: validatedRequest() bails out to next() when
# either one is missing, which serves the whole app to anyone holding the URL.
AUTH_TOKEN="$ADMIN_PASSWORD"
export AUTH_TOKEN

# /app/server/storage holds the SQLite database, the uploaded documents, the LanceDB index and the
# downloaded embedding model. STORAGE_DIR moves three of those four and not the database, whose
# path is hardcoded in the Prisma datasource, so the directory itself is what has to move.
#
# First boot only: the image seeds this tree with assets/, models/ and documents/, and the copy
# carries them onto the volume. `/.` copies the contents rather than the directory, and the guard
# leaves a volume restored from an earlier deploy exactly as it was found.
if [ ! -d /data/storage ]; then
  mkdir -p /data/storage
  cp -a /app/server/storage/. /data/storage/
fi
rm -rf /app/server/storage
ln -s /data/storage /app/server/storage

# /app/server/.env is where dumpENV() writes every setting changed in the UI: the chosen LLM
# provider, its API key, the embedder and the vector store. It is written to a path derived from
# __dirname, so nothing in the manifest can move it, and on a machine that idle-stops it would come
# back empty with the instance reset to no provider configured.
#
# Seeded from the image's copy, which carries upstream's commented .env.example, so a first boot
# starts from the defaults upstream ships rather than from an empty file.
if [ ! -f /data/.env ]; then
  cp -a /app/server/.env /data/.env 2>/dev/null || touch /data/.env
fi
rm -f /app/server/.env
ln -s /data/.env /app/server/.env

# Upstream's entrypoint, untouched: it runs the Prisma migrations and then supervises the server
# and the document collector. exec so that it, and not this script, is what the platform restarts.
exec /bin/bash /usr/local/bin/docker-entrypoint.sh
