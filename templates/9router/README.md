# 9Router

Self-hosted LLM router with fallback across 40+ providers.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/9router)

## Overview

[9Router](https://github.com/decolua/9router) is a self-hosted gateway that sits between your
coding tools and multiple model providers. You point Claude Code, Codex, Cursor, Cline or any
OpenAI-compatible client at one endpoint, and 9Router routes each request to a provider: falling
back to another when one is unavailable or rate-limited. Upstream advertises routing across 40+
providers with automatic fallback.

This template runs the upstream image behind a thin wrapper whose entrypoint chowns the platform
volume to the app's runtime user before handing over — upstream drops privileges to `node`
internally, and without that step nothing it writes lands on the volume.

## What you get by hosting it

- One HTTPS endpoint your tools point at, instead of provider-specific configuration in each tool.
- Provider keys held in one place that you control, stored on a persistent volume: configuration
  survives restarts, scale-to-zero wakes, and redeploys.
- One variable to set at deploy time; providers are configured in the app's own UI afterwards.

## What you need before deploying

- A dashboard password for `INITIAL_PASSWORD` (the only deploy-time variable).
- Provider accounts and API keys for whichever providers you intend to route to. You add these in
  the app after it starts.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `INITIAL_PASSWORD` | yes | Dashboard login password. The app refuses its built-in default password on remote logins, and this platform offers no local shell to change it from, so the password must be set here. |

The service listens on port 20128, is health-checked on `/api/health`, and stores its state
(provider keys, accounts, `jwt-secret`) under `/data` on a persistent volume.

## After deploy

1. Open the service URL and log in with the `INITIAL_PASSWORD` you set.
   The login page's "Default password is 123456" hint is upstream's static text and does not
   apply to this deployment — the default is rejected on remote logins.
2. Add your provider keys in the app's interface.
3. Point your tools at the service URL as their OpenAI-compatible base URL.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. Upstream publishes both, and this image pins
  the multi-arch index rather than one platform's manifest.
- Upstream: <https://github.com/decolua/9router>
- Image: `docker.io/decolua/9router`, pinned to `0.5.55` (by digest, via `./Dockerfile`)
- License: MIT (upstream `decolua/9router`).
