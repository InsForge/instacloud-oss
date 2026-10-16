# Umami's official image, pinned by tag and by the index digest (the top-level Digest: of
# `docker buildx imagetools inspect ghcr.io/umami-software/umami:3.4.0`, not one of its
# per-platform children), which carries linux/amd64 and linux/arm64.
#
# The overlay is two scripts and two npm packages. The application is untouched: the Next.js build,
# the Prisma migrations and the server all come from upstream, and ./entrypoint.sh still runs
# upstream's own startup sequence.
FROM ghcr.io/umami-software/umami:3.4.0@sha256:85909afc45bdcda1917394594a087421fdbb05610fded0fa9f6fb861abb2f367

USER root

# pg and bcryptjs, for ./set-admin.cjs. They go in a directory of their own rather than into
# /app/node_modules: the tree upstream builds there is pnpm's isolated layout plus Next.js's traced
# standalone output, and what is requirable from it is an implementation detail of a build we do not
# control. Both packages are pure JavaScript, so this installs the same bytes on either
# architecture. npm is gone from this image (upstream deletes it in the runner stage so the packages
# vendored in the npm CLI are not shipped), so this is pnpm.
RUN mkdir -p /insta \
    && echo '{"name":"insta-umami-tools","private":true}' > /insta/package.json \
    && cd /insta \
    && pnpm add pg@8.23.1 bcryptjs@3.0.3

COPY set-admin.cjs /insta/set-admin.cjs
COPY entrypoint.sh /insta/entrypoint.sh
RUN chmod 0755 /insta/entrypoint.sh \
    && chmod 0644 /insta/set-admin.cjs

# Back to the image's own runtime user and working directory. /insta is read-only to it, which is
# all the entrypoint needs.
USER nextjs
WORKDIR /app

EXPOSE 3000

# Replaces upstream's `CMD ["sh", "scripts/start-docker.sh"]`, which this reproduces with two steps
# in front of it.
CMD ["sh", "/insta/entrypoint.sh"]
