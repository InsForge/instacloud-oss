# whisper-turbo.c has no published image anywhere (no Docker Hub account, no ghcr package,
# no git tags), so this builds the upstream C server from a pinned commit rather than
# referencing someone else's artifact.
#
# Upstream ships its own Dockerfile.cloud, which fetches and converts the 1.6 GB GGML
# checkpoint on FIRST BOOT into a mounted volume. That shape cannot work here: the entrypoint
# does the download and the conversion BEFORE it execs the server, so nothing is listening on
# the port for several minutes, and the template deploy health gate sends a real HTTP request
# and gives up long before that. The model is therefore converted at BUILD time and baked in.
# Costs a ~1.5 GB image and a slow CI build; buys a deploy that answers /health immediately,
# needs no volume, needs no network at boot, and comes back identically after a restart.
#
# amd64 only, and not by omission: `make server` compiles with -DWHISPER_X86 and links the
# AVX2/AVX-512/VNNI kernels under src/x86. There is a generic fallback in the tree, but the
# server target does not use it, so there is no arm64 image to publish.

# Pinned to the INDEX digest of debian:bookworm-slim (the top-level Digest:, not one of the
# per-architecture children), matching what upstream's own Dockerfile.cloud builds against.
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      gcc make libc6-dev zlib1g-dev libgomp1 ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

# Upstream publishes no releases and no tags, so the commit IS the pin. Keep this in step with
# `upstream.pinned` in insta.template.yaml.
ARG UPSTREAM_REF=54ad979a08e654929186b374d266a4ced291f1be
WORKDIR /src
# Fetch the single pinned commit rather than cloning a branch: a branch would move under this
# build and silently ship something other than what the manifest claims to have pinned.
RUN git init -q . \
    && git remote add origin https://github.com/baryhuang/whisper-turbo.c \
    && git fetch -q --depth 1 origin "$UPSTREAM_REF" \
    && git checkout -q FETCH_HEAD

# CFLAGS left at the Makefile's own default (-O3 -std=c11 -Wall -Wextra -Wpedantic). Upstream's
# Dockerfile.cloud adds -Werror; that turns any warning from a future base-image gcc into a red
# build for a template whose binary would have been fine, so it is deliberately not carried over.
RUN make server build/import-ggml OPENMP=-fopenmp

# The importer takes the ORIGINAL F16/F32 GGML large-v3-turbo checkpoint, not a prequantized
# one. URL and SHA-256 are upstream's, from docker-entrypoint.cloud.sh.
ARG GGML_URL=https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
ARG GGML_SHA256=1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69
# Upstream documents the converted artifact as exactly 847,660,800 bytes. Checked here because
# the checkpoint hash only proves the INPUT was right: a truncated or half-written conversion
# would otherwise ship as a model that mmaps fine and returns nonsense on the first request.
ARG WHTRBO_BYTES=847660800
RUN mkdir -p /model \
    && curl -fL --retry 3 -o /tmp/ggml-large-v3-turbo.bin "$GGML_URL" \
    && echo "$GGML_SHA256  /tmp/ggml-large-v3-turbo.bin" | sha256sum -c - \
    && ./build/import-ggml /tmp/ggml-large-v3-turbo.bin /model/turbo-q8.whtrbo \
    && rm -f /tmp/ggml-large-v3-turbo.bin \
    && actual=$(stat -c %s /model/turbo-q8.whtrbo) \
    && if [ "$actual" != "$WHTRBO_BYTES" ]; then \
         echo "converted model is $actual bytes, expected $WHTRBO_BYTES" >&2; exit 1; \
       fi

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251

# libgomp1 for the OpenMP runtime, zlib1g for the -lz the server links against. curl and
# ca-certificates are for entrypoint.sh's optional diarization fetch, and nothing else: the server
# is a static-ish C binary with no interpreter and no package manager behind it.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgomp1 zlib1g curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/build/whisper-turbo-server /usr/local/bin/whisper-turbo-server
COPY --from=build /model/turbo-q8.whtrbo /opt/whisper-turbo/turbo-q8.whtrbo
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Prove the baked model actually loads, here, where the failure is a red build rather than a red
# deploy: start the real server on loopback (where it needs no API key) and wait for the route the
# manifest uses as its health check. A conversion that passed the size check and still produced
# something the binary cannot map would otherwise only surface on someone's deploy.
RUN set -eu; \
    /usr/local/bin/whisper-turbo-server /opt/whisper-turbo/turbo-q8.whtrbo 8080 127.0.0.1 & \
    pid=$!; \
    ok=""; i=0; \
    while [ "$i" -lt 60 ]; do \
      if curl -fsS -m 2 http://127.0.0.1:8080/health | grep -q '"status":"ready"'; then ok=1; break; fi; \
      i=$((i + 1)); sleep 1; \
    done; \
    kill "$pid" 2>/dev/null || true; \
    [ -n "$ok" ] || { echo "the server did not answer /health with the baked model" >&2; exit 1; }

# Matches the 8 shared vCPUs the platform's compute machines are configured with; the server
# clamps this to 1-8 anyway. Overridable per deploy from the manifest.
ENV OMP_NUM_THREADS=8

EXPOSE 8080

# The wrapper does one job: fetch the gated Community-1 diarization checkpoints when the deploy
# supplies HF_TOKEN. Port, bind address and model path stay literal inside it, so with no token it
# is a two-line script that execs the same command this used to declare directly.
ENTRYPOINT ["/entrypoint.sh"]
