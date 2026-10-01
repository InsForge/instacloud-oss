# The official image, pinned by tag and by the index digest (the top-level Digest: of
# `docker buildx imagetools inspect clickhouse:26.8.11.7`, not one of its per-platform children),
# which carries linux/amd64 and linux/arm64. `clickhouse:lts` resolves to this same index today.
FROM docker.io/library/clickhouse:26.8.11.7@sha256:562c7a17cac49632a19b0b529738c021fcf6bc75144f105fbfaed3d89208229e

# Two files, and that is the whole overlay. The server, its entrypoint and the stock config are
# upstream's; see ./instacloud.xml and ./entrypoint.sh for why each is here.
COPY instacloud.xml /etc/clickhouse-server/config.d/instacloud.xml
COPY entrypoint.sh /insta-entrypoint.sh
RUN chmod 0644 /etc/clickhouse-server/config.d/instacloud.xml \
    && chmod 0755 /insta-entrypoint.sh

# The HTTP interface. Upstream also exposes 9000 (native) and 9009 (interserver); the platform
# routes one port, and only this one speaks a protocol a client can reach over HTTPS.
EXPOSE 8123

ENTRYPOINT ["/insta-entrypoint.sh"]
