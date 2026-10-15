# WorkAdventure, as one deployable web service.
#
# Upstream self-hosts as six containers (contrib/docker/docker-compose.prod.yaml): Traefik, play,
# back, map-storage, an icon server and Redis. Two things in that wiring a template cannot have:
#
#   * play reaches back over gRPC and back reaches map-storage over gRPC, both on a private Docker
#     network. `${services.<name>.host}` resolves to the edge router, which routes HTTP and nothing
#     else, so neither call could cross a service boundary here.
#   * Traefik splits ONE hostname across those containers by path, and play alone needs two of its
#     ports on it: 3000 for HTTP and 3001 for the game's WebSocket, which are separate listeners in
#     play/src/server.ts and cannot be collapsed. A template gets one routed port per service.
#
# So the processes live in one container behind one routed port, with nginx making the same splits
# Traefik makes upstream, and entrypoint.sh supervising them. Nothing is rebuilt from source and
# nothing is rebranded: play, back and map-storage are copied out of upstream's own published
# images at the pinned tag.
#
# What is NOT here, and why: the uploader (chat file upload, which needs the Matrix stack this
# image does not ship) and Coturn (a TURN server is its own machine with its own port range).

FROM docker.io/thecodingmachine/workadventure-back:v1.34.1 AS back
FROM docker.io/thecodingmachine/workadventure-map-storage:v1.34.1 AS map-storage

# The favicon fetcher play points ICON_URL at, the same image and tag upstream's prod Compose uses.
# MIT, and built CGO_ENABLED=0 (see upstream's Makefile build_linux_amd64), so the binary from this
# Alpine image runs unchanged on Debian.
FROM docker.io/matthiasluedtke/iconserver:v3.21.0 AS icon

# play is the base rather than a stage: it is by far the largest of the three, it already carries
# the node runtime the other two were built against (node:24-trixie-slim), and uWebSockets.js ships
# a prebuilt .node that has to match that runtime's ABI and libc.
FROM docker.io/thecodingmachine/workadventure-play:v1.34.1

# Upstream's image drops to `node`; this one runs the whole stack, writes the volume and binds the
# routed port, so it stays root. See ./README.md.
USER root

# nginx: the only process facing the network, and the password gate, because WorkAdventure has no
# password login of its own (anonymous, or OIDC against a provider you run).
# redis: where back keeps the Scripting API's variables, as upstream's Compose does.
# openssl: hashes the gate password at boot; apache2-utils is not needed for that.
RUN apt-get update && apt-get install -y --no-install-recommends \
        nginx-light redis-server openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/sites-enabled/default /etc/nginx/nginx.conf

COPY --from=back /usr/src /opt/back
COPY --from=map-storage /usr/src /opt/map-storage
COPY --from=icon /iconserver /usr/local/bin/iconserver

# map-storage's own start script rebuilds its Svelte UI on every boot when PATH_PREFIX is set,
# because vite.config.ts bakes `base: ${PATH_PREFIX}/ui/` into the bundle. This template always
# sets PATH_PREFIX, so that build would run on every deploy and every wake from zero, inside the
# platform's health window. Done once here instead, and the entrypoint starts the server directly
# rather than through `npm run start`, which is what would trigger it again.
WORKDIR /opt/map-storage/map-storage
RUN PATH_PREFIX=/map-storage npm run front:build \
    && grep -q '/map-storage/ui/' dist-ui/index.html

# All three apps start through tsx, and each image hoists it somewhere slightly different depending
# on how npm resolved that workspace. It is a TypeScript runner, not an app-specific binary, so one
# is enough for all three; asserted here because a missing one would only surface as a container
# that dies on its first boot, which the platform reports as an internal deployment failure.
RUN set -eu; \
    for candidate in \
        /usr/src/node_modules/.bin/tsx \
        /usr/src/play/node_modules/.bin/tsx \
        /opt/back/node_modules/.bin/tsx \
        /opt/back/back/node_modules/.bin/tsx \
        /opt/map-storage/node_modules/.bin/tsx \
        /opt/map-storage/map-storage/node_modules/.bin/tsx ; do \
        if [ -x "$candidate" ]; then ln -sf "$candidate" /usr/local/bin/wa-tsx; break; fi; \
    done; \
    test -x /usr/local/bin/wa-tsx; \
    test -f /usr/src/play/src/server.ts; \
    test -f /opt/back/back/src/server.ts; \
    test -f /opt/map-storage/map-storage/src/index.ts

# A template, not the running config: entrypoint.sh substitutes the gate-cookie token at boot.
# Checked here with a stand-in of the REAL length, because what breaks depends on that length: a
# 64-character map key overflows the default map hash bucket and nginx then refuses to start.
COPY nginx.conf /etc/nginx/nginx.conf.template
RUN mkdir -p /run/workadventure /var/log/nginx \
    && stand_in=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
    && sed "s|__WA_GATE_TOKEN__|$stand_in|g" /etc/nginx/nginx.conf.template > /tmp/nginx.check.conf \
    && nginx -t -c /tmp/nginx.check.conf \
    && rm /tmp/nginx.check.conf

COPY entrypoint.sh /entrypoint.sh
# Parsed here, because nothing else would: a syntax error in an ENTRYPOINT is only discovered by a
# deploy, where the platform reports it as an internal template deployment failure.
RUN bash -n /entrypoint.sh && chmod +x /entrypoint.sh

WORKDIR /
EXPOSE 8080
CMD ["/entrypoint.sh"]
