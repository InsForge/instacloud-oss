# Rakazo

Persistent AI teammates with their own memory and routines.

> **Draft.** The template deploys and has been verified end to end, but it stays out of the catalog
> while two calls are pending. It packs upstream's four-process backend into a single container,
> because server-side template deploys support web services only in v1; and it turns the bot
> **computer** surface off (`SANDBOX_PROVIDER=none`), because bot computers are sibling Docker
> containers started by a supervisor holding `/var/run/docker.sock`, which no template service can
> be given. Both are shape decisions, not bugs. See the pull request that added this directory.

## Overview

[Rakazo](https://github.com/elie222/rakazo) is an open-source platform for running persistent AI
teammates: bots with their own conversations, memory, routines and history, which keep running when
you close the tab. You bring your own model credentials. It is reachable from the web, from an
Electron desktop app and from an Expo mobile app; this template hosts the backend and the web app,
which is also the "Existing instance" the desktop and mobile apps connect to.

Upstream is explicit that this is not a static site: it is a long-running API, a Graphile Worker,
Postgres and a computer provider. This template runs the first three, with Postgres as a managed
service. The overlay image (`./Dockerfile`) adds one file to upstream's own application image: an
entrypoint that applies Prisma migrations and then runs the API, the worker and the Vite preview of
the web app side by side, because upstream's stock command starts only the API and a manifest
carries no `command:` field.

## What you get by hosting it

- Bots that stay on. Routines and scheduled wakeups fire from graphile-worker polling Postgres
  inside the service, which is why it is declared always-on.
- An HTTPS URL serving the web app, same-origin-proxying `/api` and `/rpc` to the API process.
- A managed Postgres holding every account, bot, conversation, memory record, routine and job.
- Model credentials, voice providers and app integrations (Composio, Pipedream Connect, remote MCP,
  OpenAPI) configured in the app's own UI after deploy, not as deploy-time variables.
- Auth, encryption and screen-proxy secrets generated for you and stored as managed secrets.

## What you need before deploying

- Nothing. The template declares no required variables.
- **Sign up immediately after deploying.** The first account registered through the web UI becomes
  the deployment owner, and registration is open by default. Until you claim it, anyone who reaches
  the URL can.
- A model provider key if you want a bot to answer on the first day. `OPENROUTER_API_KEY` is the
  deploy-form shortcut; any supported provider can be connected in the UI instead.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `OPENROUTER_API_KEY` | optional | OpenRouter key for model calls, from <https://openrouter.ai/keys>. Leave blank and connect a provider in the app after signing up. |
| `SIGNUPS_ENABLED` | optional | `false` closes registration. Read on the API's **first** start only and never reapplied, so setting it before you have an owner account locks you out of your own deployment. |
| `SIGNUP_ALLOWLIST` | optional | Comma-separated emails or `@domains` allowed to register. A non-empty list makes every sign-in require email verification, so pair it with `SMTP_URL`. |
| `SMTP_URL` | optional | Transactional email for verification and password recovery, e.g. `smtps://user:password@smtp.example.com:465`. Without it there is no forgot-password flow; signed-in password changes still work. |
| `EMAIL_FROM` | optional | Sender for those emails, e.g. `Rakazo <no-reply@example.com>`. Pairs with `SMTP_URL`. |
| `COMPOSIO_API_KEY` | optional | Composio key enabling the app-integrations catalog, from <https://composio.dev>. Pipedream, remote MCP and OpenAPI tool sources are alternatives set in the UI. |
| `BETTER_AUTH_SECRET` | generated | Signs session cookies. You never set or read it. |
| `ENCRYPTION_KEY` | generated | Passphrase for the AES-256-GCM store holding the credentials you enter in the UI. Generated once; changing it strands everything already stored. |
| `SCREEN_PROXY_SECRET` | generated | Signs browser-screen capabilities. Upstream refuses to start if it equals `BETTER_AUTH_SECRET`, so it is a separate generator. |
| `DATABASE_URL` | platform | Bound from the `db` service. |

Set by the template, not by you: `DATA_DIR=/data` (upstream's default of `./data` resolves inside
`/app`, which the image leaves root-owned while running as `USER node`), `API_HOST=127.0.0.1` and
`API_PROXY_TARGET=http://127.0.0.1:3100` (the API is reachable only from the preview server in the
same container; 5173 is the one exposed port), `BETTER_AUTH_URL` / `WEB_ORIGIN` / `API_URL` resolved
to the service's own HTTPS URL (cookies and CORS follow them), `RAKAZO_HOST` resolved to its
hostname (Vite preview's `allowedHosts` is exactly this one value, and every request to any other
host gets a 403), `SANDBOX_PROVIDER=none`, `CLOUD_AGENT_PROVIDER=none`, `AGENT_RUNTIME=pi`,
`WAKEUP_DRIVER=graphile` and `LOG_FORMAT=json`.

The volume at `/data` is small under `SANDBOX_PROVIDER=none`: agent home directories belong to the
Docker computer provider, which is off here. The state that matters is in Postgres.

## After deploy

1. Open `https://<your-service-url>` and **create the first account**. It becomes the deployment
   owner.
2. Connect a model: Settings, then the model provider section, or set `OPENROUTER_API_KEY` at deploy
   time to skip this.
3. Create a bot and talk to it. Give it a routine if you want it working while you are away.
4. Optional: in the desktop or mobile app choose **Existing instance** and enter this HTTPS URL.

What is **not** available in this deployment: the **Agent computer** panes (Browser, Terminal,
Files, graphical Desktop). Those run in per-bot sibling containers started by upstream's sandbox
supervisor over the Docker socket. Chat, memory, routines, delegation to peer bots and the
MCP/OpenAPI/Composio/Pipedream tool sources do not depend on it. For the computer surface, follow
upstream's [self-hosting guide](https://github.com/elie222/rakazo/blob/main/docs/self-host.md) on a
VM you control.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. Upstream publishes both and this image only adds
  an entrypoint.
- Upstream: <https://github.com/elie222/rakazo>
- Self-hosting guide: <https://github.com/elie222/rakazo/blob/main/docs/self-host.md>
- Image: `ghcr.io/elie222/rakazo/app`, pinned to `sha-771c18024d46a647ac5cd6e6334190a234bc8e1b`.
  Upstream publishes no release tag yet, only `edge` and one `sha-<commit>` tag per main build.
- License: Apache-2.0 (upstream `elie222/rakazo`).
