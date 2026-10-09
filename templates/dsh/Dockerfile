# Base pinned by digest (multi-arch OCI index: linux/amd64 + linux/arm64): tags float.
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

# nginx: behind the sign-in gate below, on loopback, normalizing Host and Origin for the harness.
# bubblewrap is load-bearing, not optional: the harness runs every shell command through a
# sandbox and falls back to failing closed when it has no runner. Its Landlock runner probes
# "unusable" on Fly's kernel (verified in a deployed container on 6.12.91-fly), which leaves
# bwrap as the only one that works there. Without it the agent cannot run a single command.
# git, curl and procps are for the agent's own shell work. ripgrep is NOT installed: the
# harness bundles its own through @vscode/ripgrep.
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash git ca-certificates curl procps nginx-light bubblewrap \
    && rm -rf /var/lib/apt/lists/*

# The InstaCloud sign-in page, and the only thing that faces the network, because the harness web
# UI ships no authentication of its own (gate/ in this repository, released as gate-v*). Plain
# JavaScript on Node built-ins, so one checksum covers both architectures.
ARG INSTA_GATE_VERSION=0.1.1
ARG INSTA_GATE_SHA256=75a11d24a0b60c277593de699505505e4d641d75077b1a32048318ba38a73966
RUN curl -fsSL "https://github.com/InsForge/instacloud-oss/releases/download/gate-v${INSTA_GATE_VERSION}/insta-gate.mjs" \
        -o /usr/local/lib/insta-gate.mjs \
    && echo "${INSTA_GATE_SHA256}  /usr/local/lib/insta-gate.mjs" | sha256sum -c -

# pnpm is how `dsh plugin add` installs plugins into a profile, which is the whole point of a
# harness whose tagline is "Everything is a Plugin". 10 or newer: the profile pnpm-workspace.yaml
# dsh writes carries `nodeLinker`, which older pnpm reads from .npmrc instead.
ARG PNPM_VERSION=11.22.0
RUN npm install -g pnpm@${PNPM_VERSION}

# upstream pin: keep in sync with insta.template.yaml (upstream.pinned)
ARG DSH_VERSION=0.1.1-rc.2
# The release candidate's transitive ranges float, and they moved under it: the @deepseek-ai/cordis
# releases of 2026-09-22 (4.0.4 and cordis-plugin-hmr 1.0.19 measured) make `dsh web` exit at boot
# with "user patch-layer watching requires the Cordis HMR service". --before resolves the tree as
# npm saw it when the 0.4.2 image was built, the last one tested. Move it with DSH_VERSION, then
# re-run gate-assertions.mjs.
ARG DSH_NPM_BEFORE=2026-09-10T17:41:34Z
RUN npm install -g --before="${DSH_NPM_BEFORE}" @deepseek-ai/dsh@${DSH_VERSION}

# Without this the Settings -> Models page is dead behind a public hostname, from the browser side
# rather than the proxy. dsh-client-connection reads `isLoopback` off the PAGE's location.hostname,
# and dsh-client-ui-settings then builds its settings mirror in "memory" mode, where ensure() and
# load() resolve on their first line and `settings.describe` is never sent at all. The pane reads
# that empty snapshot as "settings are unavailable in this browser": no request, no console error.
# Upstream gives up there because the server pins those RPCs to a loopback Host, which the Host
# rewrite in nginx.conf already satisfies, so the client guard refuses on a premise this image
# does not match. Changes what the UI offers, not what the API allows.
# Asserted, not best-effort, so a version bump that restructures any of it fails here instead of
# shipping a dead Models page. Every match is collected rather than the first, because the
# assertions below are only worth anything if they cover the file that actually gets patched.
# Counted with `grep -oF`, not `-cF`: -c counts LINES, and a minified release could carry the
# guard twice on one line.
RUN set -eu; \
    files="$(find "$(npm root -g)" -type f -path '*dsh-client-connection/lib/client.js')"; \
    test "$(printf '%s\n' "$files" | grep -c .)" -eq 1; \
    f="$files"; \
    needle='isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),'; \
    test "$(grep -oF "$needle" "$f" | wc -l)" -eq 1; \
    sed -i "s#$needle#isLoopback: true,#g" "$f"; \
    test "$(grep -oF "$needle" "$f" | wc -l)" -eq 0; \
    grep -qF 'isLoopback: true,' "$f"; \
    echo "relaxed the client-side loopback guard in $f"

# Every env name this template sets or documents, asserted against the tree that reads them.
# GIT_TOKEN was advertised for four commits and read by nothing; this is how that stops recurring.
# JSON is excluded alongside Markdown: a name surviving only in a package manifest is not a read.
# Rooted at the dsh package because npm nests this tree; nothing else sits under the global root.
# The two names upstream takes straight off process.env are asserted in that form, which is what
# separates a consumed name from a mentioned one. The rest reach it through a string constant
# (`BASE_URL_ENV = "DEEPSEEK_BASE_URL"`), so the bare name is the only thing there is to match.
RUN set -eu; \
    root="$(npm root -g)/@deepseek-ai/dsh"; \
    for v in DSH_HOME DSH_TELEMETRY_DISABLED DSH_PERMISSION_MODE DEEPSEEK_API_KEY DEEPSEEK_BASE_URL; do \
        grep -rqF --include='*.js' --include='*.yml' "$v" "$root" \
            || { echo "env name $v is read by nothing in dsh ${DSH_VERSION}"; exit 1; }; \
    done; \
    for v in DSH_TELEMETRY_DISABLED DSH_PERMISSION_MODE; do \
        grep -rqF --include='*.js' --include='*.yml' "process.env.$v" "$root" \
            || { echo "env name $v is no longer read off process.env in dsh ${DSH_VERSION}"; exit 1; }; \
    done; \
    echo "all documented env names are read by dsh ${DSH_VERSION}"

# The grep and glob tools resolve ripgrep from an optional per-platform package, and a missing
# optional dependency is silent at install and only fails when the model calls the tool. Fail
# the build instead. `dsh --version` separately proves the bin and its 450+ deps load at all.
RUN dsh --version
RUN rg_bin="$(find "$(npm root -g)" -type f -path '*@vscode/ripgrep-*/bin/rg' -print -quit)" \
    && test -n "$rg_bin" && test -x "$rg_bin" \
    && echo "bundled ripgrep: $rg_bin"

# Replaces Debian's stock config, and checked here, so a config nginx will not load fails the build
# rather than a deploy.
COPY nginx.conf /etc/nginx/nginx.conf
RUN mkdir -p /run/dsh /tmp/nginx && nginx -t

ENV HOME=/data/home
ENV DSH_HOME=/data/dsh

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Everything that matters runs as `node`, and this is the whole point of the sandbox. dsh wraps
# every shell command the model runs in bubblewrap with `--ro-bind /` plus a `--bind` of the
# session workspace, and passes NO `--unshare-user`. As root that leaves the read-only binds
# unlocked: the sandboxed process still holds CAP_SYS_ADMIN, so `mount -o remount,rw /data` undoes
# the boundary in one command, which is exactly what an agent asked to install a plugin discovered
# on its first attempt. As `node`, bwrap (not setuid here) must open a user namespace to get that
# capability, and the kernel locks every mount it inherits, so the same remount answers EPERM and
# the agent has to ask the operator to widen the policy instead.
#
# No `USER` directive, deliberately: the entrypoint needs one root moment to chown a volume it did
# not create (a 0.1.0 volume, a restored backup and a bind mount all arrive root-owned), and it
# drops to `node` with setpriv --inh-caps=-all before starting anything. It also refuses to start
# if it is still root by then, so the boundary does not quietly depend on that drop being intact.
# /run/dsh and /tmp/nginx are made here because /run is root-owned at runtime.
RUN mkdir -p /data /run/dsh /tmp/nginx && chown -R node:node /data /run/dsh /tmp/nginx

EXPOSE 8080
CMD ["/entrypoint.sh"]
