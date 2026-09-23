# Base pinned by digest (multi-arch OCI index: linux/amd64 + linux/arm64): tags float.
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

RUN apt-get update && apt-get install -y --no-install-recommends \
        bash git ca-certificates curl ripgrep procps \
    && rm -rf /var/lib/apt/lists/*

# ttyd: browser terminal over HTTPS (same approach as Railway's pi template)
ARG TTYD_VERSION=1.7.7
# Pinned checksums of the ttyd 1.7.7 release binaries: a tampered or swapped asset fails the build.
ARG TTYD_SHA256_X86_64=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
ARG TTYD_SHA256_AARCH64=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165
# ttyd logs its credential on every start; the sed below prints ** instead, same length.
ARG TTYD_PATCHED_SHA256_X86_64=df0740b9ccd3e27ddd2b80a05918a2b372e4bb07593ee383ccfec8b461703971
ARG TTYD_PATCHED_SHA256_AARCH64=ce4f524e5e801ff99f56d6d93daed6d16ce358757e9422f67c2f938b6aca6467
RUN arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) ttyd_arch=x86_64;  ttyd_sha="$TTYD_SHA256_X86_64";  patched_sha="$TTYD_PATCHED_SHA256_X86_64" ;; \
        arm64) ttyd_arch=aarch64; ttyd_sha="$TTYD_SHA256_AARCH64"; patched_sha="$TTYD_PATCHED_SHA256_AARCH64" ;; \
        *)     echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}" \
        -o /usr/local/bin/ttyd \
    && echo "${ttyd_sha}  /usr/local/bin/ttyd" | sha256sum -c - \
    && sed -i 's/  credential: %s/  credential: **/' /usr/local/bin/ttyd \
    && echo "${patched_sha}  /usr/local/bin/ttyd" | sha256sum -c - \
    && chmod +x /usr/local/bin/ttyd

# upstream pin: keep in sync with insta.template.yaml (upstream.pinned)
RUN npm install -g @openai/codex@0.148.0

ENV HOME=/data/home
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 7681
CMD ["/entrypoint.sh"]
