#!/command/with-contenv sh
# Two things the container environment has to be right about before anything upstream starts, both
# written into s6's own environment directory the way upstream's postgres-init writes DATABASE_URL.
# Nothing here changes what OpenBot does; it only settles two values the platform cannot.
set -eu

ENVDIR=/run/s6/container_environment

# 1. THE API'S PORT, PINNED.
#
# The platform injects PORT into every web service, naming the port it routes to, and that is the
# number Caddy listens on here. OpenBot's server reads PORT as well (server/src/config.ts: PORT and
# SERVER_PORT name one number, and two that disagree are a startup error), so without this the API
# would try to bind the port the proxy already holds and the service would come up dead with
# "address in use" as the only clue. 3001 is the image's own default and is loopback-only.
printf '3001' > "$ENVDIR/PORT"
# SERVER_PORT too, since upstream errors when the two are set and disagree, and a platform or an
# operator could have set either.
printf '3001' > "$ENVDIR/SERVER_PORT"

# 2. THE CREDENTIAL VAULT'S KEY, KEPT ON THE VOLUME.
#
# KEY_ENCRYPTION_KEY has to be the base64 of exactly 32 bytes AND round-trip through base64
# unchanged, which rules out the platform's `secret:N` generator: it mints N base64url characters,
# which is not the encoding of anything. It also has to be the SAME key on every boot, or every
# credential stored through /admin/credentials stops decrypting, so a value minted per start would
# be worse than none.
#
# So it is generated once and lives beside the database on the same volume, exactly as upstream
# keeps the embedded cluster's password there. An operator who supplies their own wins: the
# variable is declared optional in the manifest and anything non-empty here is left alone.
KEY_FILE=/var/lib/postgresql/key-encryption-key

if [ -z "${KEY_ENCRYPTION_KEY:-}" ]; then
  if [ ! -s "$KEY_FILE" ]; then
    # head -c, not od: `base64` is coreutils and is in this image, and the result is standard
    # base64 with padding, which is what upstream's round-trip check accepts.
    mkdir -p /var/lib/postgresql
    ( umask 077; head -c 32 /dev/urandom | base64 -w0 > "$KEY_FILE" )
  fi
  # Read with `cat` rather than `$(<)`, which is a bashism this /bin/sh does not have.
  printf '%s' "$(cat "$KEY_FILE")" > "$ENVDIR/KEY_ENCRYPTION_KEY"
fi
