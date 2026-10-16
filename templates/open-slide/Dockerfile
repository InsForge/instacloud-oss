# Base pinned by digest (multi-arch OCI index: linux/amd64 + linux/arm64): tags float.
# @open-slide/core needs node ^20.19 || >=22.12.
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

# curl fetches the sign-in gate below.
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# The InstaCloud sign-in page, and the only thing that faces the network, because the open-slide
# dev server ships no authentication of its own and its API writes files on request (gate/ in this
# repository, released as gate-v*). Plain JavaScript on Node built-ins, so one checksum covers both
# architectures.
ARG INSTA_GATE_VERSION=0.1.1
ARG INSTA_GATE_SHA256=75a11d24a0b60c277593de699505505e4d641d75077b1a32048318ba38a73966
RUN curl -fsSL "https://github.com/InsForge/instacloud-oss/releases/download/gate-v${INSTA_GATE_VERSION}/insta-gate.mjs" \
        -o /usr/local/lib/insta-gate.mjs \
    && echo "${INSTA_GATE_SHA256}  /usr/local/lib/insta-gate.mjs" | sha256sum -c -

WORKDIR /opt/open-slide

# The workspace is scaffolded by upstream's own `init`, not hand-written here, so what deploys is
# what `npx @open-slide/cli init` gives a user on their own machine: the same package.json, the
# same tsconfig, the same getting-started deck, the same agent skills.
# `init` logs a failed dependency install and still exits 0, so the binary is asserted rather
# than assumed: without it the image would build and the container would die on its first boot.
ARG OPEN_SLIDE_CLI_VERSION=2.0.0
RUN npx --yes @open-slide/cli@${OPEN_SLIDE_CLI_VERSION} init . --use-npm --no-git --name open-slide-workspace \
    && test -x node_modules/.bin/open-slide

# upstream pin: keep in sync with insta.template.yaml (upstream.pinned). The scaffold declares a
# caret range for the runtime, which would move under a rebuild and silently change what a
# deployed instance gets on its next image pull.
ARG OPEN_SLIDE_VERSION=2.0.1
RUN npm install --save-exact @open-slide/core@${OPEN_SLIDE_VERSION} \
    && test "$(node -p "require('/opt/open-slide/node_modules/@open-slide/core/package.json').version")" = "${OPEN_SLIDE_VERSION}" \
    && ./node_modules/.bin/open-slide --version

# The scaffold's config is empty. This one points the three content directories at the volume and
# keeps the server on loopback behind the gate.
COPY open-slide.config.ts ./open-slide.config.ts

# What a first boot copies onto an empty volume: the scaffolded deck, its folder manifest, and the
# two empty trees. They move out of the workspace because the config now reads them from /data,
# and a directory left here would be shadowed by the mount anyway.
RUN mkdir -p seed && mv slides themes assets seed/

# The dev server compares the workspace's copy of the built-in agent skills against core's on
# every start and, with no TTY to ask, writes a notice to stderr. The image pins both halves, so
# there is nothing an operator could do about a drift between them: skip the check and keep the
# container's logs to things that matter.
ENV OPEN_SLIDE_SKIP_SKILLS_CHECK=1

COPY entrypoint.sh /entrypoint.sh
# Parsed here, because nothing else would: a syntax error in an ENTRYPOINT is only discovered by a
# deploy, where the platform reports it as an internal template deployment failure.
RUN bash -n /entrypoint.sh && chmod +x /entrypoint.sh
EXPOSE 8080
CMD ["/entrypoint.sh"]
