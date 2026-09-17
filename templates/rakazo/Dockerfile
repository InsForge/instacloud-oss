# Upstream's own application image, unmodified apart from the process it starts and a Docker
# Engine for the bot computers to run in.
#
# Pinned to the OCI INDEX digest of sha-771c1802... (= `edge` at the time of writing), not to one
# of its children: the child digests resolve to a single architecture whatever --platform asks for,
# and this template declares both. Upstream publishes no release tag yet, so a `sha-<commit>` tag
# is the only immutable name this image has.
FROM ghcr.io/elie222/rakazo/app:sha-771c18024d46a647ac5cd6e6334190a234bc8e1b@sha256:3e8f80fc055811efaa489c34b1c9dcbb999969bf3925cfd1ebddf8ce9b553b7e

# The image runs as USER node and everything below installs system software, so the rest of this
# file is root. The entrypoint drops back to node for the three application processes; see there.
USER root

# iptables: dockerd's bridge driver programs the NAT and FORWARD rules that give a bot computer
#   outbound network, and refuses to start the bridge without it. Debian's is the nft backend.
# util-linux: setpriv, which the entrypoint uses to exec the application processes as uid 1000.
#   Present in this base already; named here so an upstream base change cannot silently remove the
#   one binary that keeps the app off root.
RUN apt-get update && apt-get install -y --no-install-recommends \
        iptables util-linux \
    && rm -rf /var/lib/apt/lists/*

# Docker Engine, from Docker's own static bundle: dockerd, containerd, containerd-shim-runc-v2,
# runc, docker-proxy, docker-init, ctr and the CLI, as one archive with one checksum per
# architecture. The apt repository would be the other option; this is a pin the build verifies.
ARG DOCKER_VERSION=29.8.1
# download.docker.com publishes no .sha256 beside these tarballs, so both were downloaded and
# hashed by hand. A tampered or swapped bundle fails the build rather than shipping.
ARG DOCKER_SHA256_X86_64=d8db66739d2e28d4933786d73e918d9be643a67fbd835db1bf740d650a259e70
ARG DOCKER_SHA256_AARCH64=667395fbffab52901b80181dfbb39ea76da2fbd7642c4fbddd24e42146b07b48
RUN arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) docker_arch=x86_64;  docker_sha="$DOCKER_SHA256_X86_64" ;; \
        arm64) docker_arch=aarch64; docker_sha="$DOCKER_SHA256_AARCH64" ;; \
        *)     echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${DOCKER_VERSION}.tgz" \
        -o /tmp/docker.tgz \
    && echo "${docker_sha}  /tmp/docker.tgz" | sha256sum -c - \
    && tar -xzf /tmp/docker.tgz -C /usr/local/bin --strip-components=1 \
    && rm /tmp/docker.tgz \
    && dockerd --version && docker --version && runc --version

# Two assumptions the entrypoint rests on, asserted here so a base-image change breaks the build
# rather than the deploy: setpriv resolves a user by NAME (util-linux >= 2.33) and can initialize
# that user's groups, and this bash takes PIDs after `wait -n` (bash >= 5.1). Without the second,
# the entrypoint would wait on its own background image pull and exit when the pull succeeded.
RUN setpriv --reuid=node --regid=node --init-groups id \
    && bash -c 'sleep 1 & pid=$!; wait -n "$pid"'

# The supervisor's fallback when it cannot inspect the computer image is to BUILD it from
# infra/sandboxes/computer, which upstream's image carries a copy of: a Chromium-and-Xvfb image
# compiled inside a bot's first request. Pointing RAKAZO_COMPUTER_CONTEXT (manifest) at an empty
# directory turns that into an immediate error naming the missing image, which is the honest
# answer during the one-off window while the entrypoint's background pull is still running.
RUN install -d -m 755 /opt/rakazo/no-computer-build

# The overlay exists for one reason: upstream's CMD is `pnpm --filter @rakazo/api start`, which is
# the API alone, with no migrations, no worker, no web face and no sandbox supervisor. A template
# manifest carries no `command:` field, so the only place to say "run the stack, not one fifth of
# it" is here.
COPY --chmod=755 entrypoint.sh /entrypoint.sh

# 5173 is the Vite preview server, the only port the manifest exposes. 3100 (API) and 7091 (the
# sandbox supervisor, which is root-equivalent) stay on loopback inside the container.
EXPOSE 5173
CMD ["/entrypoint.sh"]
