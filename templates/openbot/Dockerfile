# OpenBot, with a door on it.
#
# Upstream already ships the whole product in one image: the built app, the API that serves it,
# Chromium for the Bots to drive, and a PostgreSQL that `EMBEDDED_POSTGRES=on` turns on. Nothing
# here rebuilds any of that. The overlay is three s6 services and nothing else:
#
#   proxy     Caddy on the routed port, HTTP basic auth, proxying to the API on loopback. OpenBot
#             refuses its no-sign-in mode on a public address and is right to; the only other way
#             in that upstream offers is an OAuth client registered against a URL that does not
#             exist until the deploy does. See s6/s6-rc.d/proxy/run.
#   tpl-init  Pins the API's port away from the one the platform routes, and generates the
#             credential vault's encryption key onto the volume once. See s6/scripts/tpl-init.sh.
#   pg-wait   Holds `migrate` until the embedded cluster is accepting connections rather than
#             merely started. Upstream's dependency says the latter, and the first deploy of this
#             template lost that race by 66 ms. See s6/scripts/pg-wait.sh.
#
# s6 is the image's PID 1, so all three arrive as ordinary s6-rc services rather than as a new
# entrypoint wrapping the old one. ENTRYPOINT ["/init"] is inherited untouched.

# upstream pin: keep in sync with insta.template.yaml (upstream.pinned)
# The digest is the OCI index's, read off the release's own container-images.json. That index
# carries exactly one platform, linux/amd64, which is what meta.architectures declares.
FROM ghcr.io/copilotkit/openbot:v0.0.15@sha256:29daf0d4f80ec6ff851ad2a5d82736ff3d49d3ff37f6acfde69ffdecd82b28dd

# Caddy, for the basic auth and the reverse proxy. A single static binary, Apache-2.0, pinned to a
# release and verified against the SHA-512 that release publishes, so a swapped or tampered asset
# fails the build rather than shipping. Only the amd64 asset, because the base image above is
# amd64 only and there is no second architecture to serve.
ARG CADDY_VERSION=2.11.6
ARG CADDY_SHA512_AMD64=422771007d505ea97efd1177a4905b2c1a471cd426668f2ace3bcda3d8e30b11f9b1610bfb02c6ad60f2a795f56124f2f5eec6409c17d5a0dd4c21a11375fb94
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    [ "$arch" = "amd64" ] || { echo "this image is amd64 only, like the base it builds on; got $arch" >&2; exit 1; }; \
    curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" \
        -o /tmp/caddy.tar.gz; \
    echo "${CADDY_SHA512_AMD64}  /tmp/caddy.tar.gz" | sha512sum -c -; \
    tar -xzf /tmp/caddy.tar.gz -C /usr/local/bin caddy; \
    rm /tmp/caddy.tar.gz; \
    chmod 0755 /usr/local/bin/caddy; \
    caddy version

# A user of its own, matching how the base treats every other process in here: the browser and the
# Bot's shell run as pwuser, the API as apiuser, the database as postgres. The proxy is the one
# process the public internet talks to, so it shares a skin with none of them. The uid continues
# the base's own sequence (ubuntu 1000, pwuser 1001, apiuser 1002) and is pinned for the same
# reason the base pins those: a number that only happens to land here today is not a contract.
RUN useradd --uid 1003 --create-home --shell /usr/sbin/nologin proxyuser

COPY Caddyfile /etc/caddy/Caddyfile

# Both halves of the proxy's start-up, run here so a mistake in either is a red build rather than a
# container that restarts once a second while the platform reports an unready port.
#
# The pipe is the point of the first half, not a convenience. `hash-password` reading a non-terminal
# stdin uses bufio.ReadBytes('\n') and returns whatever error that gives back, so input with no
# trailing newline hands it io.EOF and the command dies with the single word "EOF". That shipped
# once; this is what would have caught it.
#
# `fmt` first, because Caddy warns on every start that a config it did not format is not formatted,
# and a warning in a template's log is a thing a reviewer has to stop and rule out. The committed
# file stays as a person wrote it; the one in the image is Caddy's own rendering of it.
RUN set -eu; \
    caddy fmt --overwrite /etc/caddy/Caddyfile; \
    probe="$(printf 'probe\n' | caddy hash-password)"; \
    case "$probe" in '$2'*) ;; *) echo "hash-password did not return a bcrypt hash" >&2; exit 1 ;; esac; \
    PROXY_PORT=8080 ADMIN_USERNAME=probe PROXY_PASSWORD_HASH="$probe" \
      caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

COPY s6 /etc/s6-overlay
RUN chmod 0755 /etc/s6-overlay/scripts/tpl-init.sh /etc/s6-overlay/scripts/pg-wait.sh \
               /etc/s6-overlay/s6-rc.d/proxy/run

# The wiring, as empty marker files, which is what s6-rc reads. Written here rather than committed
# because an empty file in a repository is a thing reviewers delete by accident and nothing
# notices until a service silently stops being started.
#
#   user/contents.d           all three belong to the bundle s6 brings up.
#   api depends on tpl-init   so `with-contenv` reads a PORT and a KEY_ENCRYPTION_KEY that are
#                             already settled rather than whatever the platform passed in.
#   pg-wait depends on postgres, and migrate on pg-wait, which puts the readiness check between
#                             the two services upstream left racing.
#
# `proxy` deliberately depends on NOTHING. It holds the only port the platform routes, so tying it
# to upstream's startup chain would turn any failure inside that chain into a dead socket and the
# platform's only report would be that the app was not ready. Started on its own it answers 502
# until the API is up, which is a thing an operator can curl.
RUN mkdir -p /etc/s6-overlay/s6-rc.d/pg-wait/dependencies.d \
    && touch /etc/s6-overlay/s6-rc.d/user/contents.d/tpl-init \
             /etc/s6-overlay/s6-rc.d/user/contents.d/pg-wait \
             /etc/s6-overlay/s6-rc.d/user/contents.d/proxy \
             /etc/s6-overlay/s6-rc.d/api/dependencies.d/tpl-init \
             /etc/s6-overlay/s6-rc.d/pg-wait/dependencies.d/postgres \
             /etc/s6-overlay/s6-rc.d/migrate/dependencies.d/pg-wait

# 3001 stays where it was and stays on loopback; this is the only port out.
EXPOSE 8080
