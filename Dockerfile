# syntax=docker/dockerfile:1.7
# ghcr.io/insforge/instacloud:<version>: the insta-oss daemon (instad) as one multi-arch image.
# Contains Node, the daemon source run with tsx, the built dashboard, the docker CLI and the
# bundled templates directory. Runs as root: it owns the Docker socket (compose.yml mounts it),
# which is root on the box anyway (spec "Known gaps"). Debian slim, not alpine: glibc for the
# docker CLI and for node's in-process reflink clone (contract decision 23; no coreutils needed).
#
# Pins are exact multi-arch tags (linux/amd64 + linux/arm64), verified on Docker Hub at
# implementation time. Bump them together with a release.
ARG NODE_IMAGE=node:22.23.2-bookworm-slim

# ---- dashboard: ui/dist ----
FROM ${NODE_IMAGE} AS ui
WORKDIR /app/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
RUN npm run build

# ---- runtime deps: production node_modules (tsx is a dependency, it is the runtime) ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- docker CLI: a static binary copied from the official cli image ----
FROM docker:28.5.2-cli AS dockercli

# ---- final ----
FROM ${NODE_IMAGE}
ARG VERSION=dev
# INSTA_OSS_MODE=server is the only behavioural switch the image bakes in; instad.env (compose
# env_file) sets or overrides everything else. Local mode on a laptop never runs this image.
ENV NODE_ENV=production \
    INSTA_OSS_MODE=server \
    INSTA_OSS_VERSION=${VERSION} \
    INSTA_OSS_TEMPLATES_DIR=/app/templates \
    INSTA_OSS_UI_DIST=/app/ui/dist
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
# The buildx plugin too: git push-to-deploy builds the pushed repo with BuildKit (git-context fetch
# and the GIT_AUTH_TOKEN build secret), which the legacy builder cannot do. Without this the daemon's
# `docker build` errors immediately and every push-to-deploy build fails.
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/lib/docker/cli-plugins/docker-buildx
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY templates ./templates
COPY --from=ui /app/ui/dist ./ui/dist
LABEL org.opencontainers.image.source=https://github.com/InsForge/instacloud-oss \
      org.opencontainers.image.version=${VERSION} \
      org.opencontainers.image.title=instacloud \
      org.opencontainers.image.description="InstaCloud open source runtime: one daemon over Docker, branchable and serverless on a single node" \
      org.opencontainers.image.licenses=Apache-2.0
# The daemon's own /healthz on its HTTP port (127.0.0.1 in host network mode). The router dispatches
# by Host and answers 404 to a bare 127.0.0.1 Host in server mode (contract decision 4), so the probe
# names the API host the way the edge does; in local mode api.localhost is a daemon host as well.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.INSTA_OSS_PORT||8080,path:'/healthz',headers:{host:'api.'+(process.env.INSTA_OSS_DOMAIN||'localhost')}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
# tsx at runtime: tsconfig uses bundler resolution with extensionless imports, which node ESM
# cannot load unbundled, and tsx is already the declared runtime of the package bin.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/main.ts"]
