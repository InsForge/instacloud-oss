# Hermes Agent

Autonomous AI agent from Nous Research, with chat in the browser and messaging channels you
connect when you want them.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/hermes)

## Overview

This template runs [Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research.
Hermes is an autonomous agent: you give it a task and it works on it with its own tools rather
than answering a single prompt. The template wraps the upstream image with a start command
(upstream's default process is an interactive terminal UI that exits without a TTY) and runs the
web dashboard behind a small nginx on the service port, with the messaging gateway supervised
beside it, state on a persistent volume. nginx exists so the same port can also publish the
Telegram and Slack webhook endpoints, which is what lets those bots keep working on a machine that
scales to zero (see [Scale to zero](#scale-to-zero)).

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
| `TELEGRAM_BOT_TOKEN` | no | Token for a Telegram bot, created with @BotFather. Telegram is connected over an inbound webhook that the template registers for you, so it is the one channel that keeps working when the machine scales to zero. Leave blank to connect Telegram (or anything else) later from the Channels page. |
| `TELEGRAM_ALLOWED_USERS` | no | Comma-separated **numeric** Telegram user IDs allowed to use the bot. Not @usernames: the adapter compares the user id and never reads the username. Get yours from @userinfobot. |
| `DISCORD_BOT_TOKEN` | no | Token for a Discord bot from the Discord Developer Portal. Discord delivers messages over a connection the bot opens, so turn always-on on in the console before connecting it. |
| `DISCORD_ALLOWED_USERS` | no | Comma-separated numeric Discord user IDs allowed to use the bot. |
| `SLACK_BOT_TOKEN` | no | Slack bot token (`xoxb-...`) from OAuth & Permissions. Slack reaches this deployment over its inbound Events API, so the bot works on a scale-to-zero machine; `SLACK_SIGNING_SECRET` goes with it. |
| `SLACK_SIGNING_SECRET` | no | The Slack app's signing secret, from Basic Information > App Credentials. Needed whenever `SLACK_BOT_TOKEN` is set; see [Scale to zero](#scale-to-zero) for the one-time setup in the Slack app. This image does not offer Slack's Socket Mode (no app-level token). |
| `SLACK_ALLOWED_USERS` | no | Comma-separated Slack member IDs (e.g. `U01ABC2DEF3`) allowed to use the bot. |
| `HERMES_GATEWAY_TOKEN` | generated | Generated 64-character token; you do not set this. |
| `TELEGRAM_WEBHOOK_SECRET` | generated | Generated 32-character token Telegram signs each webhook update with; you do not set this, and only the machine and Telegram ever see it. |

Set by the template, not by you: `HERMES_HOME=/data/.hermes` (state on the volume),
`HERMES_DASHBOARD_PORT=8081` (the dashboard listens on a port the platform does not route, behind
nginx, which owns the service port 8080), the Telegram webhook settings `TELEGRAM_WEBHOOK_URL=<service URL>/telegram`,
`TELEGRAM_WEBHOOK_PORT=8443`, `TELEGRAM_WEBHOOK_HOST=127.0.0.1`, and the Slack Events API settings
`SLACK_EVENTS_URL=<service URL>/slack/events`, `SLACK_EVENTS_PORT=8444`, `SLACK_EVENTS_HOST=127.0.0.1`.
The entrypoint checks the nginx config, starts nginx and the dashboard, and starts the gateway as
a managed daemon the dashboard's System and Channels pages control.

The image applies three small patches to upstream at build time. `slack-events-api.patch`: the
Slack adapter serves Slack's Events API through slack_bolt's own HTTP helpers (upstream speaks
Socket Mode only). `dashboard-slack-events.patch`: the Channels page's Slack card asks for the
signing secret and shows the Request URL instead of asking for a Socket Mode app-level token.
`telegram-keep-pending-updates.patch`: upstream registers the Telegram webhook with
`drop_pending_updates=True` on every boot, and on a machine that scales to zero the message that
woke the machine is still in flight while the gateway boots, so that flag threw away the first
message after every wake; the patch keeps pending updates and Telegram redelivers them.

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

## Scale to zero

The platform decides a machine is idle from the traffic it can see, which is inbound traffic
through its router. Messaging channels differ in which direction their traffic flows, and that
decides whether a channel survives scale to zero:

- **Telegram: yes.** The template registers a webhook with Telegram at deploy time (the
  `TELEGRAM_WEBHOOK_*` settings above), so Telegram pushes each update to the service URL. That is
  inbound traffic: it wakes a stopped machine, the gateway handles the update, and the machine can
  scale to zero again afterwards. Telegram waits for the answer and retries deliveries, so the
  first message after an idle period is answered once the machine is up: a wake takes ten to
  twenty seconds and the gateway a few more to start, so expect the reply to that first message
  after about half a minute, and later messages within seconds.
- **Slack: yes.** This image runs Slack over the Events API only. Set `SLACK_BOT_TOKEN` and
  `SLACK_SIGNING_SECRET` (at deploy time or later on the dashboard's Channels page, which shows the
  exact Request URL), then in the Slack app's settings: turn **Socket Mode** off, open **Event
  Subscriptions**, enable events, and paste `<service URL>/slack/events` as the Request URL. Slack
  verifies the URL immediately, so open the dashboard first so the machine is awake, and it must
  also be awake later when you save scope or event changes. Subscribe to the bot events Hermes
  documents (`message.im`, `message.channels`, `message.groups`, `message.mpim`, `app_mention`) and
  reinstall the app. From then on Slack pushes each event to the service URL: inbound traffic that
  wakes the machine. Slack expects an answer within 3 seconds and a wake takes about 15, so the
  first message after an idle period is delivered on Slack's retry about a minute later; messages
  while the machine is awake are answered at once. A bot token without the signing secret is
  reported as a configuration error on the Channels page rather than silently falling back to
  Socket Mode, and a bot that goes quiet after the switch almost always has the Slack app's Socket
  Mode toggle still on.
- **Discord: no.** The Discord gateway is a connection the bot opens outward. The router never sees
  it, an idle machine is stopped, the connection dies, and a Discord message cannot wake it: the bot
  stays silent until someone opens the dashboard. Discord offers no inbound delivery for channel
  messages, so Discord needs always-on.

The template ships with the platform's scale-to-zero default: the machine stops while idle and
wakes on the next dashboard visit, Telegram message or Slack event, and you pay only for the time it
runs. If you connect Discord, turn always-on on in the console first; it costs a small continuous
RAM charge and keeps that connection alive.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. Upstream publishes both and this image only
  adds an entrypoint.
- Documentation: <https://hermes-agent.nousresearch.com/docs/>
- Upstream: <https://github.com/NousResearch/hermes-agent>
- Image: `docker.io/nousresearch/hermes-agent`
- License: MIT (upstream `NousResearch/hermes-agent`).
