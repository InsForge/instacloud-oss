# An overlay, not a fork. nanobot publishes no container image anywhere: the repository ships a
# Dockerfile (a recipe for building one from a checkout, with a Node stage that compiles the
# frontend), and neither Docker Hub nor ghcr carries a published artifact. Its one published
# artifact is the PyPI wheel, and that wheel already contains the built WebUI under
# nanobot/web/dist, so this image installs the wheel and skips the frontend build entirely.
#
# What it adds on top is the three things a public deploy needs and a library has no reason to
# carry: an instance root on the platform's volume, a seeded config that enables the WebUI channel
# and puts the password in front of it, and the privilege drop upstream's own entrypoint performs.
#
# Pinned to the INDEX digest of python:3.12-slim-bookworm (the top-level Digest:, not one of the
# per-architecture children), so the FROM resolves on both declared architectures.
FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258

# The runtime binaries nanobot reaches for. The first four are upstream's own image list:
#   git             the agent's git tooling, and how skills are installed
#   openssh-client  git over ssh
#   libmagic1       file-type detection on uploads and attachments
#   ca-certificates every outbound provider call
# and the last two are this image's additions, for an agent whose tools are a shell:
#   ripgrep         the `rg` tool registers only when the binary is present (agent/tools/rg.py)
#   procps          `ps` for the agent's own shell work, the call `claude-code` and `dsh` make
# Upstream also installs bubblewrap. It is left out here: tools.exec.sandbox is opt-in and off by
# default, and upstream's own compose file shows bwrap needs cap_add SYS_ADMIN plus an unconfined
# seccomp profile, neither of which a compute machine grants. Shipping it would be a sandbox that
# cannot start rather than one a user chose not to use.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates git openssh-client libmagic1 ripgrep procps \
    && rm -rf /var/lib/apt/lists/*

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONFAULTHANDLER=1 \
    VIRTUAL_ENV=/opt/nanobot-venv \
    PATH=/opt/nanobot-venv/bin:$PATH

RUN python -m venv /opt/nanobot-venv

# upstream pin: keep in sync with insta.template.yaml (upstream.pinned). Every dependency resolves
# to a prebuilt wheel on both architectures, which is why nothing here compiles and the arm64 leg
# cross-builds. The platform-specific wheel (manylinux_2_17_x86_64 / _aarch64) is nanobot's own:
# it bundles the native TUI binary, which this image never runs but which is what makes the wheel
# architecture-tagged.
ARG NANOBOT_VERSION=0.3.5
RUN pip install --no-cache-dir "nanobot-ai==${NANOBOT_VERSION}"

# The WebUI is served from inside the wheel; without it the gateway answers 404 at / and the health
# gate fails on a deploy instead of here. Asserted rather than assumed because it is the one thing
# that makes installing from PyPI equivalent to upstream's two-stage build.
RUN python -c "import pathlib, nanobot.web; \
index = pathlib.Path(nanobot.web.__file__).parent / 'dist' / 'index.html'; \
assert index.is_file(), f'the wheel carries no built WebUI at {index}'; \
print('WebUI bundle OK:', index)" \
    && nanobot --version

# Upstream starts as root, hands the data directory to a non-root user and re-execs as that user,
# failing closed rather than running an agent with a shell tool as root. entrypoint.sh does the
# same, so the image needs the account. uid 1000 matches upstream's.
RUN useradd -m -u 1000 -s /bin/bash nanobot \
    && chown -R nanobot:nanobot /opt/nanobot-venv /home/nanobot

COPY config.seed.json /opt/nanobot/config.seed.json
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Start the real entrypoint, with the real seeded config, and wait for the exact path the manifest
# declares as its health check. This is the check that would otherwise only run on someone's
# deploy, where the CLI reports every runtime failure as "internal template deployment failure":
# a config key the schema rejects, a WebUI bundle that does not resolve, a CLI flag a release does
# not have, a channel that refuses to bind, a privilege drop that cannot write its own data dir.
# HOME is overridden to /tmp so the build never writes where the volume will mount, which is also
# what proves the entrypoint derives everything from HOME rather than from a hardcoded path.
#
# `kill "$pid"` is the whole of the cleanup, and it reaches the gateway because the entrypoint's
# `exec setpriv ... /entrypoint.sh` and `exec nanobot gateway` chain keeps the original PID. A
# `pkill -f "nanobot gateway"` sweep stood here and did nothing twice over: the gateway renames
# itself `nanobot-gateway`, so the pattern never matched it, while docker runs this step as
# `/bin/sh -c '<script>'`, so it DID match the build shell's own command line. That only passed
# because a RUN shell is PID 1, where the kernel discards a default-disposition SIGTERM.
RUN set -eu; \
    HOME=/tmp/smoke ADMIN_PASSWORD=smoke-test-only /entrypoint.sh & \
    pid=$!; \
    ok=""; i=0; \
    while [ "$i" -lt 90 ]; do \
      if python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/', timeout=2)" 2>/dev/null; then ok=1; break; fi; \
      i=$((i + 1)); sleep 1; \
    done; \
    kill "$pid" 2>/dev/null || true; \
    sleep 1; \
    rm -rf /tmp/smoke; \
    [ -n "$ok" ] || { echo "the gateway did not answer / on 8765 through entrypoint.sh" >&2; exit 1; }; \
    echo "gateway health path OK after ${i}s"

# Where the platform mounts the volume, and the whole of how nanobot's state gets onto it:
# ~/.nanobot is the instance root it resolves config, sessions, memory, transcripts, cron, media,
# logs and the default workspace from. Set after the install steps so no build cache lands here.
ENV HOME=/data

EXPOSE 8765

ENTRYPOINT ["/entrypoint.sh"]
