# Base pinned by digest (multi-arch OCI index: linux/amd64 + linux/arm64): tags float.
# node rather than plain debian, and the same digest the other terminal templates pin: herdr runs
# coding agents instead of shipping one, and the agents it detects (claude code, codex, opencode)
# install from npm. A box without npm would open on a terminal that cannot install the thing it
# exists to herd.
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

# git: herdr's worktree workspaces run `git worktree` directly, so the feature is dead without it.
# openssh-client: its saved SSH machines shell out to `ssh`, same story.
# ncurses-term: ttyd hands each session TERM=xterm-256color, and the programs a user runs inside a
# pane (less, vim) read that entry from terminfo. herdr itself writes ANSI directly and does not.
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash git ca-certificates curl openssh-client procps ripgrep less ncurses-term \
    && rm -rf /var/lib/apt/lists/*

# ttyd: browser terminal over HTTPS, and the only process here that speaks HTTP. herdr's own API is
# a unix socket, so without this there is nothing for the platform's health gate to reach.
ARG TTYD_VERSION=1.7.7
# Pinned checksums of the ttyd 1.7.7 release binaries: a tampered or swapped asset fails the build.
ARG TTYD_SHA256_X86_64=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
ARG TTYD_SHA256_AARCH64=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165
RUN arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) ttyd_arch=x86_64;  ttyd_sha="$TTYD_SHA256_X86_64" ;; \
        arm64) ttyd_arch=aarch64; ttyd_sha="$TTYD_SHA256_AARCH64" ;; \
        *)     echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}" \
        -o /usr/local/bin/ttyd \
    && echo "${ttyd_sha}  /usr/local/bin/ttyd" | sha256sum -c - \
    && chmod +x /usr/local/bin/ttyd

# herdr: upstream's own release binary, not a source build. It is a single static-linked Rust
# binary, so building it here would cost a full cargo compile per architecture for the same bytes.
# upstream pin: keep HERDR_VERSION in sync with insta.template.yaml (upstream.pinned).
# The checksums are upstream's own, read off distribution/latest.json at tag v0.9.1 rather than
# computed from whatever the download happened to return.
# The last step of the RUN below runs the binary, so the arm64 leg of the build proves the arm64
# asset executes rather than only that it downloaded. Under QEMU in CI, which is where a wrong
# asset would otherwise pass unnoticed.
ARG HERDR_VERSION=0.9.1
ARG HERDR_SHA256_X86_64=2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7
ARG HERDR_SHA256_AARCH64=f4ccf4de745f2cb9a39a983e9ba3703dad50ec2a58dea83026ceab721bbd8d9e
RUN arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) herdr_arch=x86_64;  herdr_sha="$HERDR_SHA256_X86_64" ;; \
        arm64) herdr_arch=aarch64; herdr_sha="$HERDR_SHA256_AARCH64" ;; \
        *)     echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-${herdr_arch}" \
        -o /usr/local/bin/herdr \
    && echo "${herdr_sha}  /usr/local/bin/herdr" | sha256sum -c - \
    && chmod +x /usr/local/bin/herdr \
    && herdr --version

# HOME on the volume: every path herdr writes hangs off it (see the manifest).
# SHELL: what a new pane runs. herdr reads $SHELL and falls back to /bin/sh, and a box for coding
# agents with `sh` in every pane is a worse box than one with bash.
# NPM_CONFIG_PREFIX on the volume, and first on PATH: npm's default global prefix is /usr/local,
# which is an image layer, so `npm i -g @anthropic-ai/claude-code` inside the terminal would
# survive until the next restart and then quietly be gone.
ENV HOME=/data/home \
    SHELL=/bin/bash \
    LANG=C.UTF-8 \
    NPM_CONFIG_PREFIX=/data/home/.npm-global
ENV PATH=/data/home/.npm-global/bin:$PATH

COPY entrypoint.sh /entrypoint.sh
COPY session.sh /usr/local/bin/herdr-web
RUN chmod +x /entrypoint.sh /usr/local/bin/herdr-web
EXPOSE 7681
CMD ["/entrypoint.sh"]
