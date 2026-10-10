#!/bin/sh
# LobeHub's own image, started the way this platform needs it. Three things happen before
# upstream's launcher takes over, and then it takes over unchanged.
set -e

PORT="${PORT:-3210}"
export PORT

# ---------------------------------------------------------------------------
# 1. The migrations the managed Postgres cannot run.
#
# Upstream's self-host stack runs paradedb/paradedb, and two migrations depend on it: one creates
# the `pg_search` extension, the next builds fourteen BM25 indexes with it. The managed Postgres
# carries pgvector but not pg_search, so `CREATE EXTENSION pg_search` aborts the migration run and
# the container never reaches the server. FTS_SEARCH_PROVIDER is pg_like in the manifest, which is
# upstream's own extension-free search provider, so nothing at runtime asks for those indexes.
#
# This rewrites the files in the running container and never in the image: the published image is
# upstream's, byte for byte, which is what LobeHub's license asks of anyone running it as a service.
# Matching on content rather than on the two filenames means an upstream release that renames or
# adds one is still handled, and says so in the log.
# ---------------------------------------------------------------------------
patched=0
for f in /app/migrations/*.sql; do
  [ -f "$f" ] || continue
  if grep -qiE 'pg_search|USING[[:space:]]+bm25' "$f"; then
    printf '%s\n%s\n%s\n' \
      '-- Replaced at container start: this statement needs ParadeDB pg_search, which the managed' \
      '-- Postgres does not have. This deployment searches with FTS_SEARCH_PROVIDER=pg_like.' \
      'SELECT 1;' > "$f"
    echo "entrypoint: neutralised $(basename "$f"), it needs ParadeDB pg_search"
    patched=$((patched + 1))
  fi
done
if [ "$patched" -eq 0 ]; then
  echo "entrypoint: no pg_search migration found, which this image version is expected to have" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. KEY_VAULTS_SECRET, the key LobeHub encrypts users' provider API keys with.
#
# It has to base64-decode to exactly 16, 24 or 32 bytes (apps/server/src/modules/KeyVaultsEncrypt),
# and the platform's generator mints a count of base64url characters, which is a different unit.
# Hashing the generated seed gives 32 bytes whatever the generator's length happens to be, and the
# same 32 bytes on every boot for the life of the deployment.
# ---------------------------------------------------------------------------
if [ -z "${LOBE_KEY_VAULTS_SEED}" ]; then
  echo "entrypoint: LOBE_KEY_VAULTS_SEED is not set" >&2
  exit 1
fi
KEY_VAULTS_SECRET="$(/bin/node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.env.LOBE_KEY_VAULTS_SEED).digest("base64"))')"
export KEY_VAULTS_SECRET

# ---------------------------------------------------------------------------
# 3. JWKS_KEY, the RS256 key set that signs LobeHub's internal JWTs.
#
# Upstream's setup.sh generates one per deployment and the manifest cannot: a generator mints
# random characters, not a key pair. So it is minted here on first boot and kept on the volume,
# because a key that changed on every restart would invalidate the tokens LobeHub hands its own
# background work. This is the only thing the volume holds.
# ---------------------------------------------------------------------------
jwks_file=/data/jwks.json
if [ ! -s "$jwks_file" ]; then
  echo "entrypoint: minting the RS256 key set at $jwks_file"
  # Upstream's own generator, from docker-compose/setup.sh.
  /bin/node -e 'const c=require("node:crypto");const {privateKey}=c.generateKeyPairSync("rsa",{modulusLength:2048});const meta={alg:"RS256",kid:c.randomBytes(8).toString("hex"),use:"sig"};process.stdout.write(JSON.stringify({keys:[{...privateKey.export({format:"jwk"}),...meta}]}))' > "$jwks_file"
fi
JWKS_KEY="$(cat "$jwks_file")"
export JWKS_KEY

# ---------------------------------------------------------------------------
# 4. Hand over to upstream's launcher, with the port answering throughout.
# ---------------------------------------------------------------------------
/bin/node /insta-boot-listener.mjs &
holder_pid=$!

# Upstream's launcher runs this same script itself; running it here first means the slow pass
# happens while the holder is still answering, and upstream's pass is then a no-op.
echo "entrypoint: running the database migrations"
/bin/node /app/docker.cjs

kill "$holder_pid" 2>/dev/null || true
wait "$holder_pid" 2>/dev/null || true

echo "entrypoint: migrations done, starting lobehub"
exec /bin/node /app/startServer.js
