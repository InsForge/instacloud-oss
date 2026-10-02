# OpenMuse publishes no image. Its only deployable artifact is a Render blueprint that builds three
# services from source: the Node API, a static Expo web export, and a private Chromium worker. This
# overlay builds the first two from one pinned commit and puts nginx in front of them, because a
# template gets one routed port and the API answers `/` with JSON rather than the UI.
#
# The browser worker is deliberately not here. It is a second image (apps/worker/Dockerfile) and a
# template directory builds exactly one, and upstream's own blueprint says the API boots either way.
#
# Base pinned by digest, the same multi-arch index the other node templates here use: tags float.
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build

# git only, and only to fetch the pinned commit. Everything else comes from the lockfile.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The version in the repository's own `packageManager` field. A different pnpm would resolve a
# different tree and `--frozen-lockfile` is what keeps this build reproducible.
RUN npm install -g pnpm@11.19.0

# upstream pin: keep in sync with insta.template.yaml (upstream.commit). A tag would be the nicer
# reference, but the repository publishes none, and the branch tip is not a pin.
ARG OPENMUSE_COMMIT=9ec439fbaa878197d9d44c2aa982cca55676dd68
RUN git clone --filter=blob:none https://github.com/CopilotKit/OpenMuse.git /src \
 && git -C /src checkout --detach "$OPENMUSE_COMMIT" \
 && rm -rf /src/.git

WORKDIR /src
RUN pnpm install --frozen-lockfile

# tsc, into /src/dist. apps/server imports packages/ by relative path rather than as workspace
# packages, so the one compile covers both and the runtime needs no workspace linking.
RUN pnpm build:server

# Expo inlines every EXPO_PUBLIC_* value into the web bundle at BUILD time, so the API address can
# never be a deploy-time variable. "/" is the one value that works on any hostname: apps/mobile/src/
# api.ts strips the trailing slash, leaving "", so every call becomes a same-origin relative path
# and the nginx below answers it. --clear matches upstream's blueprint, which hit a cached Metro
# transform holding a stale address.
RUN EXPO_PUBLIC_API_URL=/ pnpm --dir apps/mobile exec expo export \
        --platform web --output-dir dist/web --clear

FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

# nginx serves the bundle and proxies /api to the API; apache2-utils writes the credential file;
# openssl mints the token-encryption key when the operator supplies none.
RUN apt-get update && apt-get install -y --no-install-recommends \
        nginx apache2-utils openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# node_modules arrives whole rather than reinstalled: pnpm's virtual store is self-contained under
# node_modules/.pnpm with relative links, so copying it keeps every version the lockfile pinned.
# It carries the Expo build's dependencies too, which is this image's main cost.
COPY --from=build /src/node_modules /app/node_modules
COPY --from=build /src/dist /app/dist
COPY --from=build /src/package.json /app/package.json
COPY --from=build /src/apps/mobile/dist/web /srv/web

COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
EXPOSE 8080
CMD ["/entrypoint.sh"]
