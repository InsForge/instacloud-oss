# InsForge, as one deployable web service.
#
# Upstream ships a four-container Compose stack: its own Postgres image, PostgREST, a Deno
# runtime and the Node server. Only the Node server speaks HTTP, and the other three are reached
# over plain TCP on a private Docker network. A template has no such network: `${services.x.host}`
# resolves to the edge router hostname, which routes HTTP and nothing else, and a managed
# `{ type: postgres }` cannot stand in for upstream's database because that database is not stock.
# It preloads `pg_cron,http,pgcrypto,insforge_pg_utils` (see deploy/docker-init/db/postgresql.conf
# upstream), and `insforge_pg_utils` is a C extension that exists only in
# ghcr.io/insforge/postgres. Migration 021 runs `CREATE EXTENSION pg_cron`, which cannot succeed
# on a server that has not preloaded it.
#
# So the four processes live in one container, behind the one routed port, supervised by
# entrypoint.sh. The base is upstream's own Postgres image for exactly the reason above.
#
# Two consequences worth stating, because they are what this file costs:
#   * The app is built from source rather than copied out of ghcr.io/insforge/insforge-oss. That
#     image is Alpine (musl) and this base is Debian trixie (glibc), so its node_modules are the
#     wrong ABI. Same commit, rebuilt against the right libc.
#   * amd64 only. The PostgREST asset used here is the linux-static-x86-64 one, and the Node
#     monorepo build is long enough that nobody has run it under QEMU for the arm64 leg. Both
#     upstream images publish arm64, so the row is winnable; it has not been won here.

# ---------------------------------------------------------------------------------------------
# Stage 1: upstream's source at the pinned tag, shared by the build and prod-deps stages.
# ---------------------------------------------------------------------------------------------
FROM node:20-bookworm-slim AS source
WORKDIR /src
# No --checksum: GitHub's on-the-fly tarballs are not promised to be byte-stable across
# regenerations, so a pinned digest here would turn into a red build for no change upstream. The
# tag is the pin, and the version assertion below is what actually catches a wrong tree.
ADD https://codeload.github.com/InsForge/InsForge/tar.gz/refs/tags/v2.3.2 /tmp/insforge.tar.gz
RUN tar -xzf /tmp/insforge.tar.gz --strip-components=1 -C /src \
 && rm /tmp/insforge.tar.gz \
 && test "$(node -p "require('./package.json').version")" = "2.3.2"

# ---------------------------------------------------------------------------------------------
# Stage 2: compile. Mirrors upstream's own build stage (turbo: shared packages, backend, frontend).
# ---------------------------------------------------------------------------------------------
FROM source AS build
RUN npm ci
RUN npm run build
# dist/server.js is the backend bundle and dist/frontend the dashboard's static files. Assert it,
# because a turbo pipeline that silently builds nothing would otherwise surface as a container
# that exits on "cannot find module" a deploy later.
RUN test -f dist/server.js && test -d dist/frontend

# ---------------------------------------------------------------------------------------------
# Stage 3: production dependencies only, resolved against the same lockfile.
# ---------------------------------------------------------------------------------------------
FROM source AS prod-deps
# Upstream strips these two scripts for the same reason: `prepare` runs tsc, and tsc is a
# devDependency that --omit=dev has just removed. The compiled output comes from the build stage.
RUN apt-get update && apt-get install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/* \
 && jq 'del(.scripts.prepare, .scripts.build)' packages/shared-schemas/package.json > /tmp/ss.json \
 && mv /tmp/ss.json packages/shared-schemas/package.json
RUN npm ci --omit=dev && npm cache clean --force

# ---------------------------------------------------------------------------------------------
# Stage 4: the two upstream binaries the stack needs beside the app, taken from their own
# releases rather than from their Docker images: both of those are musl or differently based, and
# a release asset comes with a checksum this file can pin.
# ---------------------------------------------------------------------------------------------
FROM debian:trixie-slim AS binaries
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip xz-utils \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /out

# PostgREST 12.2.12, the version upstream's Compose and Zeabur templates both pin. The
# linux-static build has no runtime library dependencies at all, so it does not care that this
# image is trixie and the binary was linked elsewhere.
RUN curl -fsSL -o pgrst.tar.xz \
      https://github.com/PostgREST/postgrest/releases/download/v12.2.12/postgrest-v12.2.12-linux-static-x86-64.tar.xz \
 && echo "5de4092f1719da3353c40bf96c8dec6913f2254a7cd0b61cc05f233153b557d5  pgrst.tar.xz" | sha256sum -c - \
 && tar -xJf pgrst.tar.xz \
 && rm pgrst.tar.xz \
 && ./postgrest --version

# Deno 2.0.6, matching upstream's denoland/deno:alpine-2.0.6. The gnu asset, since the runtime
# image is glibc.
RUN curl -fsSL -o deno.zip \
      https://github.com/denoland/deno/releases/download/v2.0.6/deno-x86_64-unknown-linux-gnu.zip \
 && echo "946c370617bfc041a353a5fb19b84c209461b1c2bb902908702e699a5276659e  deno.zip" | sha256sum -c - \
 && unzip -q deno.zip \
 && rm deno.zip \
 && ./deno --version

# ---------------------------------------------------------------------------------------------
# Stage 5: warm the Deno module cache at build time, so first boot does not have to reach
# deno.land. functions/server.ts imports deno.land/x/postgres and deno.land/std by URL.
# ---------------------------------------------------------------------------------------------
FROM debian:trixie-slim AS deno-cache
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=binaries /out/deno /usr/local/bin/deno
COPY --from=source /src/functions /opt/insforge-functions
ENV DENO_DIR=/deno-dir
WORKDIR /opt/insforge-functions
RUN deno cache server.ts

# ---------------------------------------------------------------------------------------------
# Stage 6: the runtime image. Upstream's Postgres, plus everything else the stack needs.
# ---------------------------------------------------------------------------------------------
# Pinned by tag AND by the index digest, which is the OCI index and not one of its children, so
# the pin stays multi-arch if the arm64 row is ever won.
FROM ghcr.io/insforge/postgres:v15.13.4@sha256:23b767e82e17da08cec1dc0c1214e3002a06154e73a2cb4dfad30ab540405698

# Node, copied file by file rather than as a whole /usr/local/bin. The node image ships its own
# /usr/local/bin/docker-entrypoint.sh, and a directory-level copy would overwrite the Postgres
# entrypoint this image is chosen for.
COPY --from=node:20-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:20-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version && npm --version

COPY --from=binaries /out/postgrest /usr/local/bin/postgrest
COPY --from=binaries /out/deno /usr/local/bin/deno

WORKDIR /app
COPY --from=prod-deps /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/docs ./docs
COPY --from=build /src/.agents/docs ./.agents/docs
# tsx resolves the backend's @/* aliases from tsconfig.json, and node-pg-migrate reads the .sql
# files straight out of backend/src, so both trees ship even though the server itself is bundled.
COPY --from=build /src/backend/src ./backend/src
COPY --from=build /src/backend/tsconfig.json ./backend/tsconfig.json
COPY --from=build /src/backend/package.json ./backend/package.json
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/packages/shared-schemas/package.json ./packages/shared-schemas/package.json
COPY --from=build /src/packages/shared-schemas/dist ./packages/shared-schemas/dist
COPY --from=build /src/packages/shared-schemas/src ./packages/shared-schemas/src

# Deliberately NOT under /app. Deno 2 walks up from its entry point looking for a workspace root,
# and /app/package.json declares npm workspaces (backend, frontend, packages/*) whose members this
# image does not ship. With the functions tree inside /app, every `deno run` died on
# "Could not find package.json for workspace member in 'file:///app/frontend/'" before it bound a
# port. Upstream never hits this because its Deno runtime is a separate container with only
# functions/ mounted. One directory up, out of the workspace, is that separation.
COPY --from=build /src/functions /opt/insforge-functions

# tsx is a devDependency upstream, but `migrate:bootstrap` runs a script through it at every boot,
# so the runtime image needs it globally. Same line upstream's own runner stage carries.
RUN npm install -g "tsx@^4.7.1" && npm cache clean --force

# Upstream's Postgres configuration, from the same commit as the app: the preload list, the
# grant-role settings insforge_pg_utils reads, the internal-schema allowlist PostgREST is scoped
# by, and the roles (anon, authenticated, project_admin) plus the RLS event triggers that
# db-init.sql installs on first initdb.
COPY --from=source /src/deploy/docker-init/db/postgresql.conf /etc/postgresql/postgresql.conf
COPY --from=source /src/deploy/docker-init/db/db-init.sql /docker-entrypoint-initdb.d/01-init.sql

COPY --from=deno-cache /deno-dir /opt/deno-dir

# Defaults the entrypoint overrides only when it has to; declared here so `docker inspect` shows
# where the stack keeps its state.
ENV PGDATA=/data/postgres \
    STORAGE_DIR=/data/storage \
    LOGS_DIR=/data/logs \
    DENO_DIR=/opt/deno-dir \
    PROJECT_ROOT=/app \
    NODE_ENV=production \
    POSTGRES_DB=insforge \
    POSTGRES_USER=postgres \
    MAX_JSON_BODY_SIZE=100mb \
    MAX_URLENCODED_BODY_SIZE=10mb \
    INSFORGE_DEPLOYMENT_METHOD=instacloud-template

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Deliberately still root, and this image has no USER. Postgres refuses to run as root, so the
# entrypoint hands it off through the base image's own docker-entrypoint.sh, which gosu's to the
# postgres user itself. Everything else stays root so that /data, which the platform mounts and
# owns as root, is writable without a chown dance.
EXPOSE 7130
ENTRYPOINT ["/entrypoint.sh"]
