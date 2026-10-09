# Hermes Agent

Autonomous AI agent from Nous Research, with chat in the browser and messaging channels you
connect when you want them.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/hermes)

## Overview

This template runs [Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research.
Hermes is an autonomous agent: you give it a task and it works on it with its own tools rather
than answering a single prompt. The template wraps the upstream image with a start command
(upstream's default process is an interactive terminal UI that exits without a TTY) and runs the
web dashboard as the main process with the messaging gateway supervised beside it, state on a
persistent volume.

The dashboard is what the service URL serves. Chat lives there too, so a fresh deploy is usable
with no messaging platform configured at all. When you want the agent on Telegram, Slack, Discord,
WhatsApp, or any other platform the gateway supports, the dashboard's Channels page connects it
after deploy: a per-platform form, an enable toggle, and a restart button that applies the change.

## What you get by hosting it

- An HTTPS URL for the Hermes dashboard, behind a username and password you choose, with no port
  forwarding or tunnel to manage. Upstream refuses to expose the dashboard without one.
- Chat with the agent directly on the dashboard, no bot token required.
- The Channels page: connect any supported messaging platform (Telegram, Slack, Discord, WhatsApp,
  Signal, Email, and more) from the browser, with connection status and a gateway restart button,
  so channel setup never needs a redeploy.
- A persistent volume mounted at `/data`, with `HERMES_HOME` pointed at `/data/.hermes` so the agent's
  state, and every channel you configure, survives restarts and redeploys.
- The gateway token generated for you (64 chars) and stored as a managed secret, so it is never
  committed anywhere or shown in the manifest.
- Your API keys and any bot tokens held as managed secrets rather than baked into an image.
- Deploys are health-gated against `/api/status`, so a container that never becomes ready is rolled
  back rather than left serving errors.

## What you need before deploying

- A username and a password of your choosing for the dashboard sign-in. There is no default and
  nothing is generated: the deploy form starts with both fields empty and will not submit until you
  fill them. A password the platform minted would be one it could never show you again.

That is all. Everything else is optional and configurable from the dashboard after deploy: an
[OpenRouter API key](https://openrouter.ai/keys) on the API Keys page (the agent calls models
through OpenRouter, so chat starts answering once one is set; fill the variable at deploy time to
skip that step), and messaging platforms on the Channels page.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | Sign-in username for the dashboard. You choose it; it may not contain a colon (HTTP basic auth uses one to separate user from password) or start with a dash. |
| `ADMIN_PASSWORD` | yes | Sign-in password for the dashboard. You choose it. |
| `OPENROUTER_API_KEY` | no | Key the agent uses for model calls. Get one at <https://openrouter.ai/keys>, or add it later on the dashboard's API Keys page; chat needs it to answer. |
| `TELEGRAM_BOT_TOKEN` | no | Token for a Telegram bot, created with @BotFather. Leave blank to connect Telegram (or anything else) later from the Channels page. |
| `TELEGRAM_ALLOWED_USERS` | no | Comma-separated **numeric** Telegram user IDs allowed to use the bot. Not @usernames: the adapter compares the user id and never reads the username. Get yours from @userinfobot. |
| `DISCORD_BOT_TOKEN` | no | Token for a Discord bot from the Discord Developer Portal. |
| `DISCORD_ALLOWED_USERS` | no | Comma-separated numeric Discord user IDs allowed to use the bot. |
| `SLACK_BOT_TOKEN` | no | Slack bot token (`xoxb-...`). Slack needs `SLACK_APP_TOKEN` too. |
| `SLACK_APP_TOKEN` | no | Slack app-level token (`xapp-...`) for Socket Mode, which needs no public callback URL. |
| `SLACK_ALLOWED_USERS` | no | Comma-separated Slack member IDs (e.g. `U01ABC2DEF3`) allowed to use the bot. |
| `HERMES_GATEWAY_TOKEN` | generated | Generated 64-character token; you do not set this. |

Set by the template, not by you: `HERMES_HOME=/data/.hermes` (state on the volume) and
`HERMES_DASHBOARD_PORT=8080`. The entrypoint binds the dashboard and starts the gateway as a
managed daemon the dashboard's System and Channels pages control.

## After deploy

1. Wait for the health check on `/api/status` to pass, then open the service URL and sign in with
   the `ADMIN_USERNAME` and `ADMIN_PASSWORD` you deployed with.
2. If you left `OPENROUTER_API_KEY` blank, open the API Keys page and set it there first.
3. Give the agent a task in the dashboard's Chat tab. This works immediately, with no messaging
   platform configured.
4. To reach the agent from a messaging app, open the Channels page: pick the platform, fill its
   form (each shows exactly the fields that platform needs and links its credential docs), enable
   it, and restart the gateway from the same page. Tokens land on the volume, so they survive
   restarts and redeploys.
5. Platforms deny unknown senders by default. Add your user ID to the platform's allowlist, or
   approve yourself via the pairing flow when the bot replies with a pairing code.
6. State lives under `/data/.hermes`, so restarts and redeploys keep the agent's memory. Deleting
   the volume resets it.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. Upstream publishes both and this image only
  adds an entrypoint.
- Documentation: <https://hermes-agent.nousresearch.com/docs/>
- Upstream: <https://github.com/NousResearch/hermes-agent>
- Image: `docker.io/nousresearch/hermes-agent`, pinned to `v2026.8.27`
- License: MIT (upstream `NousResearch/hermes-agent`).
