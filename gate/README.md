# insta-gate

The InstaCloud sign-in page in front of the browser terminal templates (`claude-code`, `codex`,
`pi`). It replaces ttyd's own HTTP basic auth: the gate listens on the routed port, checks
`ADMIN_USERNAME` and `ADMIN_PASSWORD` through a sign-in page, and proxies a signed-in browser to ttyd
on loopback, WebSocket included. The spec is
[plans/2026-10-08-ttyd-login-gate-spec.md](../plans/2026-10-08-ttyd-login-gate-spec.md).

## Use it in a template

The release file is plain JavaScript on Node built-ins, so one checksum covers every architecture.

```dockerfile
ARG INSTA_GATE_VERSION=0.1.0
ARG INSTA_GATE_SHA256=<the release's insta-gate.mjs.sha256>
RUN curl -fsSL -o /usr/local/lib/insta-gate.mjs \
        "https://github.com/InsForge/instacloud-oss/releases/download/gate-v${INSTA_GATE_VERSION}/insta-gate.mjs" \
    && echo "${INSTA_GATE_SHA256}  /usr/local/lib/insta-gate.mjs" | sha256sum -c -
```

```bash
exec node /usr/local/lib/insta-gate.mjs --name claude-code -- \
  ttyd -i lo -p 7682 -W tmux -u new-session -A -s main
```

`--port` (default 7681) is the routed port and `--upstream-port` (default 7682) is ttyd's. The gate
starts the command after `--` as its child, forwards `SIGTERM`, `SIGINT` and `SIGHUP`, and exits
with the child's status. It opens the routed port only once the child answers on the upstream port.
If that takes longer than `--ready-timeout` seconds (default 30), it stops the child and exits 1, so
the deploy fails instead of reporting healthy.

## Build

```bash
npm ci                  # the repository's pinned Vitest
npm --prefix ui ci      # the page is rendered from ui/'s @insforge/ui, React and console theme
npm --prefix gate ci
npm --prefix gate run build    # writes gate/dist/insta-gate.mjs
INSTA_GATE_FILE=gate/dist/insta-gate.mjs npx vitest run gate/
```

`npx vitest run gate/` without the variable tests `src/server.mjs` with a bare fallback page, and the
root `npm test` runs it that way.

## Release

Bump `version` in `gate/package.json`, merge, then push the tag `gate-v<version>` on that commit.
`.github/workflows/gate.yml` builds, tests the built file and publishes `insta-gate.mjs` with
`insta-gate.mjs.sha256`. Then bump `INSTA_GATE_VERSION` and `INSTA_GATE_SHA256` in each terminal
template, with its own version bump.
