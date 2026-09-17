# Rakazo

Persistent AI teammates with their own memory and routines.

> **Draft.** The template deploys and has been verified end to end, but it stays out of the catalog
> while one call is pending: it packs upstream's whole backend — the API, the graphile worker, the
> web preview, a sandbox supervisor and a Docker daemon for the bot computers — into a single
> container, because server-side template deploys support web services only in v1. That is a shape
> decision, not a bug, and a human has to sign off on it. See the pull request that added this
> directory.

## Overview

[Rakazo](https://github.com/elie222/rakazo) is an open-source platform for running persistent AI
teammates: bots with their own conversations, memory, routines and history, which keep running when
you close the tab. You bring your own model credentials. It is reachable from the web, from an
Electron desktop app and from an Expo mobile app; this template hosts the backend and the web app,
which is also the "Existing instance" the desktop and mobile apps connect to.

Upstream is explicit that this is not a static site: it is a long-running API, a Graphile Worker,
Postgres and a computer provider. This template runs all of them, with Postgres as a managed
service. The overlay image (`./Dockerfile`) adds a Docker Engine and one entrypoint script to
upstream's own application image: the entrypoint applies Prisma migrations and then runs the API,
the worker, the Vite preview of the web app, the sandbox supervisor and `dockerd` side by side,
because upstream's stock command starts only the API and a manifest carries no `command:` field.

## What you get by hosting it

- Bots that stay on. Routines and scheduled wakeups fire from graphile-worker polling Postgres
  inside the service, which is why it is declared always-on.
- **Bot computers.** Each bot gets a Linux desktop of its own — Browser, Terminal, Files and the
  graphical Desktop pane — running as a container of a Docker daemon inside the service. A run
  needs a computer, so this is what makes chat work at all, not an extra.
- An HTTPS URL serving the web app, same-origin-proxying `/api` and `/rpc` to the API process.
- A managed Postgres holding every account, bot, conversation, memory record, routine and job.
- Model credentials, voice providers and app integrations (Composio, Pipedream Connect, remote MCP,
  OpenAPI) configured in the app's own UI after deploy, not as deploy-time variables.
- Auth, encryption, screen-proxy and supervisor secrets generated for you and stored as managed
  secrets.

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
| `SANDBOX_SUPERVISOR_TOKEN` | generated | Bearer for the supervisor that creates bot computers. Upstream keeps it independent of the two above, because that surface is control of the service's Docker daemon. |
| `DATABASE_URL` | platform | Bound from the `db` service. |

Set by the template, not by you: `DATA_DIR=/data` (upstream's default of `./data` resolves inside
`/app`), `API_HOST=127.0.0.1` and `API_PROXY_TARGET=http://127.0.0.1:3100` (the API is reachable
only from the preview server in the same container; 5173 is the one exposed port), `BETTER_AUTH_URL`
/ `WEB_ORIGIN` / `API_URL` resolved to the service's own HTTPS URL (cookies and CORS follow them),
`RAKAZO_HOST` resolved to its hostname (Vite preview's `allowedHosts` is exactly this one value, and
every request to any other host gets a 403), `SANDBOX_PROVIDER=docker` with
`SANDBOX_SUPERVISOR_URL=http://127.0.0.1:7091` and `SUPERVISOR_HOST=127.0.0.1` (the supervisor is a
sibling process, not a sibling service, and loopback keeps a root-equivalent API off every other
interface), `RAKAZO_COMPUTER_IMAGE` pinned by digest to upstream's desktop image at the same commit
as the app image, `SANDBOX_SCREEN_NETWORK=published`, `SANDBOX_MAX_COMPUTERS_PER_SPACE=2`,
`CLOUD_AGENT_PROVIDER=none`, `AGENT_RUNTIME=pi`, `WAKEUP_DRIVER=graphile` and `LOG_FORMAT=json`.

The volume at `/data` holds two things: each bot's home directory, and the Docker data-root the bot
computers live in — their image, their writable layers and their networks. A computer and the files
in it survive a restart because of it. Everything else that matters is in Postgres.

## After deploy

1. Open `https://<your-service-url>` and **create the first account**. It becomes the deployment
   owner.
2. Connect a model: Settings, then the model provider section, or set `OPENROUTER_API_KEY` at deploy
   time to skip this.
3. Create a bot and talk to it. Give it a routine if you want it working while you are away.
4. Open the bot's **computer** to watch it work, or take control of the desktop yourself.
5. Optional: in the desktop or mobile app choose **Existing instance** and enter this HTTPS URL.

Two things to expect on the **first** boot only. The 400 MB desktop image is pulled in the
background while the database migrations run, so for roughly the first minute opening a bot computer
reports the image as missing; it works from then on, and after a restart the image is already on the
volume. And bots share a Team Computer by default, with at most two computers per space here,
because each is capped at 2 GB of the same machine the app runs on.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. Upstream publishes both for the app and the
  desktop image, and the overlay's Docker Engine download picks per architecture with its own
  checksum for each.
- Upstream: <https://github.com/elie222/rakazo>
- Self-hosting guide: <https://github.com/elie222/rakazo/blob/main/docs/self-host.md>
- Sandbox providers: <https://github.com/elie222/rakazo/blob/main/docs/self-host-sandbox-providers.md>
- Images: `ghcr.io/elie222/rakazo/app` and `ghcr.io/elie222/rakazo/computer`, both pinned to
  `sha-771c18024d46a647ac5cd6e6334190a234bc8e1b`. Upstream publishes no release tag yet, only `edge`
  and one `sha-<commit>` tag per main build. Docker Engine 29.8.1, from Docker's static bundle.
- License: Apache-2.0 (upstream `elie222/rakazo`).
