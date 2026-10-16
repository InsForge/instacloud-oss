# Pinned to the OCI INDEX of documenso v2.20.0, never one of its children: the index carries
# linux/amd64 and linux/arm64, and a child digest resolves to that one platform whatever
# --platform says. Repin with `docker buildx imagetools inspect docker.io/documenso/documenso:<tag>`
# and take the top-level Digest, not a Manifests row.
FROM docker.io/documenso/documenso:v2.20.0@sha256:05d2ede9fb87bfd8eedc11d81b8bdee43c3e775ea46c4fb64973153ca5ef8eb8

# Nothing about the application is rebuilt. The overlay is one shell script, which runs upstream's
# own docker/start.sh as its last line. openssl, which the script needs, is already in the image:
# the runner stage builds on a base that installs it.
USER root
COPY --chmod=0755 entrypoint.sh /insta-entrypoint.sh

# Back to the image's own runtime user and working directory. start.sh resolves
# ../../packages/prisma/schema.prisma from here, and the volume at /data is owned by this uid.
USER nodejs
WORKDIR /app/apps/remix

EXPOSE 3000

# Replaces upstream's `CMD ["sh", "start.sh"]`, which the entrypoint reproduces with two steps in
# front of it.
CMD ["sh", "/insta-entrypoint.sh"]
