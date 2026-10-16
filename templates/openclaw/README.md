# OpenClaw

Self-hosted personal AI assistant, reachable from your chat apps.

> **Draft.** The template deploys and has been verified end to end; it stays out of the catalog
> while the publish decision is pending — the upstream pin rides `latest` by digest because
> upstream's dated image tags have stalled, and listing it is a separate call.

## Overview

[OpenClaw](https://github.com/openclaw/openclaw) is a personal AI assistant you run yourself.
Upstream describes it as your own personal AI assistant, on any OS and any platform, with your data
staying yours. You reach it from a messaging channel (Telegram, Discord, WhatsApp, ...) or from its
web Control UI rather than a hosted chat window.

This template runs the official upstream image with only its start command replaced (see
`./Dockerfile`): the stock command exits on an unconfigured fresh volume and binds loopback only,
and a manifest cannot override a container command, so a wrapper image carries the
`--allow-unconfigured --port 8080 --bind lan` flags instead. Everything inside is stock upstream.

## What you get by hosting it

- An assistant gateway that runs continuously, rather than only while your machine is on.
- An HTTPS URL for the Control UI at `/openclaw`, where you configure model providers and connect
  channels after deploy — no deploy-time keys needed.
- A gateway auth token generated for you and stored as a managed secret.
- A persistent volume mounted at `/data` holding `openclaw.json`, auth profiles, channel and session
  state (`OPENCLAW_STATE_DIR=/data/.openclaw`) and the agent workspace
  (`OPENCLAW_WORKSPACE_DIR=/data/workspace`), so all of it survives restarts and redeploys.

## What you need before deploying

- Nothing. The template declares no required variables.
- A model provider key (Anthropic or OpenAI) and any channel tokens are entered after deploy in
  the Control UI's onboarding, not as deploy variables.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `OPENCLAW_GATEWAY_TOKEN` | generated | Admin secret for the gateway and Control UI. You do not set it; read it with `insta secrets --print` when the UI asks you to connect. |

Set by the template, not by you: `OPENCLAW_STATE_DIR=/data/.openclaw` and
`OPENCLAW_WORKSPACE_DIR=/data/workspace` (state and workspace on the volume),
`XDG_CONFIG_HOME=/data/.config` (the auth-profile encryption key lives under it, deliberately
outside the state dir, and must survive redeploys or credentials entered in the Control UI stop
decrypting),
`OPENCLAW_PUBLIC_URL` resolved to the service's own HTTPS URL (the image's entrypoint appends it
to `gateway.controlUi.allowedOrigins` before start, or the gateway would reject the Control UI's
browser connection), and `NODE_OPTIONS=--max-old-space-size=1536` (upstream's own fly.toml value).

The template no longer pins a compute size, so a new service starts at whatever your plan gives
one, and you can change it afterwards from the service settings. The service is
always-on, because channel connections (for example a Telegram long-poll) live inside the process
and an idle machine would never wake for an incoming message.

## After deploy

1. Open `https://<your-service-url>/openclaw`.
2. Connect with the gateway token: `insta secrets --print` shows `OPENCLAW_GATEWAY_TOKEN`. The
   first connection triggers upstream's one-time device pairing; the image approves
   token-authenticated devices itself within ~15 s (upstream expects `openclaw devices approve`
   on the gateway host, and the platform has no shell into the machine), so if the first
   Connect reports pairing, simply retry it.
3. Follow the onboarding to add a model provider key and connect a channel (Telegram is the
   fastest: just a bot token).

## Links

- Architectures: `linux/amd64` and `linux/arm64`. Upstream publishes both and this image only
  adds an entrypoint.
- Upstream: <https://github.com/openclaw/openclaw>
- License: MIT (upstream `openclaw/openclaw`; the LICENSE file is the standard MIT text, with
  third-party notices recorded separately in the repository).
