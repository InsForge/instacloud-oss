# Twenty's own release image is the whole application: server, compiled frontend, worker and the
# entrypoint that creates the schema and runs the migrations. This overlay adds the two pieces the
# platform cannot supply, and nothing else.
#
#   1. Redis. Twenty requires REDIS_URL for its cache and its BullMQ queues, and a template
#      manifest may only declare `web` and `postgres` services, so there is no managed redis to
#      point REDIS_URL at. It runs on loopback here with its data on the volume.
#   2. The worker. Upstream runs it as a second container off this same image; the platform answers
#      `type: worker` with "template deploys support web services only in v1", so it runs here as a
#      child of the entrypoint.
#
# No part of Twenty is rebuilt or repackaged: the upstream release tag is the base and
# entrypoint.sh calls upstream's own /app/entrypoint.sh for setup and migrations.
FROM docker.io/twentycrm/twenty:v2.41.0

USER root

# From the base image's own alpine 3.23 community repo, so nothing is downloaded at boot. The
# lower-bound form matches the base image's own apk lines: an exact pin breaks the build the day
# alpine rebuilds the package. 8.4.2-r0 is what both amd64 and aarch64 carry today.
# Redis 8 is AGPL-3.0-only OR SSPL-1.0; AGPL is the same license Twenty itself ships under.
RUN apk add --no-cache 'redis>=8.4.2-r0'

COPY entrypoint.sh /insta-entrypoint.sh
RUN chmod +x /insta-entrypoint.sh

# Upstream runs as uid 1000 and the platform's volume ownership follows the image's USER, so /data
# is writable without dropping privileges at runtime.
USER 1000

EXPOSE 3000
# Replaces upstream's ENTRYPOINT rather than wrapping it as CMD: upstream's would run the
# migrations before redis exists, and the cache flush it does on the way through needs redis up.
ENTRYPOINT ["/insta-entrypoint.sh"]
