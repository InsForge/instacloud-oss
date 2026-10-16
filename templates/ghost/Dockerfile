# Pinned to the OCI INDEX of ghost 6.70.0, never one of its children: the index carries amd64,
# arm64 and arm/v7, and a child digest resolves to that one platform whatever --platform says.
# Repin with `docker buildx imagetools inspect docker.io/library/ghost:<tag>` and take the
# top-level Digest, not a Manifests row.
FROM docker.io/library/ghost:6.71.0@sha256:00032f15726204565bf799ac272ee6fef588547cce50bedd38de3db55272c053

# Two files and nothing else. Ghost, Ghost-CLI, the baked config.production.json and upstream's own
# /usr/local/bin/docker-entrypoint.sh are untouched, and that entrypoint still runs as the last
# line of this one, so the volume chown, the step down to the `node` user and the seeding of the
# stock themes all happen exactly as they do in the unmodified image.
COPY --chmod=0755 entrypoint.sh /insta-entrypoint.sh
COPY --chmod=0644 setup-owner.cjs /insta-setup-owner.cjs

ENTRYPOINT ["/insta-entrypoint.sh"]
# The image's own CMD, repeated because an ENTRYPOINT instruction resets CMD to empty, and
# because upstream's entrypoint keys its chown-and-seed branch off seeing exactly this argv.
CMD ["node", "current/index.js"]
