# OpenDots publishes no image. The repository ships a multi-stage Dockerfile but nothing builds or
# pushes it: there is no release workflow, and ghcr carries no `copilotkit/opendots`. So this
# template builds the `app` target of upstream's own Dockerfile from a pinned commit, with two
# differences, both noted where they happen: the sources arrive by `git clone` rather than `COPY .`,
# and the Playwright browser download is skipped because this template deploys no browser worker.
#
# Base pinned by digest, the same multi-arch index the other node templates here use: tags float.
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build

# git only, and only to fetch the pinned commit. Everything else comes from the lockfile.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# upstream pin: keep in sync with insta.template.yaml (upstream.commit). The repository publishes no
# tag and no release, so a commit is the only pin available; the branch tip is not one.
ARG OPENDOTS_COMMIT=625452e06cde74cb25b0ce319e2c1be0488f5a5f
RUN git clone --filter=blob:none https://github.com/CopilotKit/OpenDots.git /src \
 && git -C /src checkout --detach "$OPENDOTS_COMMIT" \
 && rm -rf /src/.git

WORKDIR /src
# The `playwright` package downloads a Chromium on install. Upstream pays for it in both stages and
# uses it only in the `browser` target; this template deploys no browser worker (WEB_SEARCH_PROVIDER
# stays on Parallel), so the binary would be an unused few hundred megabytes in every layer.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

# `vite build` into dist/client and `tsc -p tsconfig.server.json` into dist/server, which is what
# upstream's own build script does and what the server expects to find beside it at runtime.
RUN npm run build

FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY --from=build /src/package.json /src/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /src/dist ./dist

# Upstream's own app stage runs as this user, and the platform's volume takes its ownership from the
# image's USER, so /data arrives writable. Nothing here starts as root and drops: that is the shape
# that produces EACCES on a mounted volume.
USER node

# HOST, PORT, DATABASE_PATH and the rest arrive from the manifest; nothing is baked in here, so the
# same image runs unchanged if any of them change. node is PID 1 and handles SIGTERM itself
# (src/server/shutdown.ts), so there is no init shim and no entrypoint script.
EXPOSE 4310
CMD ["node", "dist/server/server/index.js"]
