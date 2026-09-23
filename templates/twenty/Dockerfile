# Twenty's own release image is the whole application: server, compiled frontend, worker and the
# entrypoint that creates the schema and runs the migrations. This overlay adds the pieces the
# manifest cannot express, and nothing else.
#
#   1. The worker's command. Upstream runs the worker as a second container off this same image,
#      distinguished only by what it runs. A manifest has no `command:` key, so both services
#      deploy this image and entrypoint.sh branches on INSTA_TWENTY_ROLE.
#   2. Holding the routed port. The compute deploy probe wants something accepting on port 3000
#      within 31 seconds and Twenty's first boot spends about a minute creating its schema before
#      it listens. See boot-listener.mjs.
#   3. SNI on the Redis connection. The managed Redis lane selects the database from the TLS
#      handshake and Twenty's two Redis clients never send a server name, so both connections are
#      opened and silently dropped. See sni.cjs, which is preloaded through NODE_OPTIONS.
#
# Redis used to be in this list, started on loopback because a manifest could not declare one. It
# is a managed `cache` service now, so nothing is installed here at all. Seeding the first account
# and clearing Twenty's example records used to be here too; both are gone, and the instance now
# comes up the way upstream ships it, with sign-up open and the examples in place.
#
# No part of Twenty is rebuilt or repackaged: the upstream release tag is the base, and setup is
# upstream's own `database:init:prod`, `upgrade`, `cache:flush` and `cron:register:all`, run by
# entrypoint.sh in upstream's order. It runs them directly rather than through
# /app/entrypoint.sh, which swallows their failures and exits 0, so a partial upgrade cannot be
# told from a clean one. See the setup block there.

# Declared before FROM so the tag is written once. Repeated after it because a build stage does
# not inherit the pre-FROM ARG scope.
ARG TWENTY_TAG=v2.41.0
FROM docker.io/twentycrm/twenty:${TWENTY_TAG}
ARG TWENTY_TAG

USER root

# What the entrypoint keys its "setup already ran" marker on. A file rather than an env var so a
# bump of the FROM tag above cannot forget to invalidate the marker, and so entrypoint.sh reads no
# variable the manifest does not declare.
RUN printf '%s\n' "$TWENTY_TAG" > /insta-twenty-version

COPY entrypoint.sh /insta-entrypoint.sh
COPY boot-listener.mjs /insta-boot-listener.mjs
COPY sni.cjs /insta-sni.cjs
RUN chmod +x /insta-entrypoint.sh

# Upstream runs as uid 1000 and the platform's volume ownership follows the image's USER, so /data
# is writable without dropping privileges at runtime.
USER 1000

EXPOSE 3000
# Replaces upstream's ENTRYPOINT rather than wrapping it as CMD: the server role has to hold the
# port before upstream's setup runs, and the worker role has to wait for a schema that upstream's
# entrypoint would assume was already there.
ENTRYPOINT ["/insta-entrypoint.sh"]
