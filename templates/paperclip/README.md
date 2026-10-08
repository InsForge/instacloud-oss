# Paperclip

Dashboard for running a team of AI agents.

> **Draft.** The template deploys and has been verified end to end; it stays out of the catalog
> while the publish decision is pending. Two calls are open: sign-up is left open after deploy so
> the operator can create the first account, and the service is always-on because Paperclip's
> schedules and agent heartbeats run inside the process.

## Overview

[Paperclip](https://github.com/paperclipai/paperclip) is a Node.js server and React UI that
orchestrates a team of AI agents. You define goals, hire agents backed by different harnesses
(Claude Code, Codex, OpenCode, Gemini CLI, OpenClaw and others), assign them tasks, and watch the
work, approvals and costs from one dashboard. Upstream's framing: if OpenClaw is an employee,
Paperclip is the company.

This template deploys the official upstream image exactly as published. Nothing is rebuilt and
there is no overlay: the manifest moves the data directory onto the volume and tells the server it
is internet-facing, and the rest is stock.

The database is Paperclip's own embedded PostgreSQL, running inside the container under the data
directory. The template declares no managed `postgres` service.

## What you get by hosting it

- An HTTPS dashboard that keeps running when your laptop is closed, which is the point of agents
  that work autonomously.
- A persistent volume at `/data` holding the embedded PostgreSQL cluster, uploaded assets, the
  instance secret key and the agent workspaces, so accounts, companies, agents and task history
  survive restarts and redeploys.
- Session and tool-action signing secrets minted for you and stored as managed secrets.
- The bundled agent CLIs (`claude`, `codex`, `opencode`, `gemini`, `kimi-code`) already installed
  in the image, so the `*_local` adapters can run without any further setup once you supply a
  provider key.

## What you need before deploying

- Nothing. The template declares no required variables.
- A model provider key if you want agents to actually run. Supply it as an optional variable at
  deploy time, or add it afterwards from the dashboard. Without one the app runs normally and the
  adapter environment checks report the missing prerequisite.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | optional | Anthropic key. Enables the bundled `claude` CLI as the `claude_local` adapter. From <https://console.anthropic.com>. |
| `OPENAI_API_KEY` | optional | OpenAI key. Enables the bundled `codex` CLI as the `codex_local` adapter. From <https://platform.openai.com>. |
| `GEMINI_API_KEY` | optional | Google key **restricted to the Gemini API** in the Google Cloud console. Unrestricted keys are blocked by Google and `gemini_local` runs fail with an auth error. |
| `PAPERCLIP_AUTH_DISABLE_SIGN_UP` | optional | Set to `true` to close sign-up. Leave it unset for the first deploy, or nobody can create the first account. |
| `BETTER_AUTH_SECRET` | generated | Session signing key. The server refuses to start without it. You never need to read it. |
| `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` | generated | Signs tool-action approvals. You never need to read it. |

Set by the template, not by you: `PAPERCLIP_HOME=/data` and
`PAPERCLIP_CONFIG=/data/instances/default/config.json` (both, because the image bakes an absolute
config path that does not follow `PAPERCLIP_HOME`, so moving only the home leaves `config.json`
and the sibling `.env` holding the instance secret key on the root filesystem, where a restart
clears them), `HOME=/data` (the bundled agent CLIs keep credentials and caches under `$HOME`),
`HOST=0.0.0.0`, `PAPERCLIP_DEPLOYMENT_MODE=authenticated`,
`PAPERCLIP_DEPLOYMENT_EXPOSURE=public` with `PAPERCLIP_PUBLIC_URL` resolved to the service's own
HTTPS URL (the image default, `private`, rejects every request whose `Host` header is not loopback
or explicitly allow-listed, which is every request arriving through the platform's edge), and
`TRUST_PROXY=1` for the single edge hop, without which the session cookie is issued without
`Secure` on an HTTPS origin.

`PORT` is deliberately not set: the platform injects its own, equal to the routed port.

The service is always-on. Paperclip's routines, schedules and agent heartbeats fire from inside
the process, so an idle machine would never wake for them. Always-on bills continuously.

## After deploy

1. Open `https://<your-service-url>/`. The sign-in page renders.
2. Choose **Sign up** and create the first account with an email and a password. Sign-up is open
   on a fresh instance, so do this immediately: the URL is public.
3. Once your account exists, set `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` on the service and restart
   if you do not want anyone else registering.
4. Add a model provider key under the app's own settings if you did not supply one at deploy time,
   then create a company, hire an agent and give it a task.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. Upstream publishes a two-architecture index for
  this tag and nothing is rebuilt here.
- Upstream: <https://github.com/paperclipai/paperclip>
- Image: <https://github.com/paperclipai/paperclip/pkgs/container/paperclip> (`ghcr.io/paperclipai/paperclip:2026.1005.0`)
- Documentation: <https://docs.paperclip.ing>
- License: MIT (upstream `paperclipai/paperclip`, LICENSE is the standard MIT text).
