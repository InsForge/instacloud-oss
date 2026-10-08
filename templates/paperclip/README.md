# Paperclip

Dashboard for running a team of AI agents.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/paperclip)

## Overview

[Paperclip](https://github.com/paperclipai/paperclip) is a Node.js server and React UI that
orchestrates a team of AI agents. You define goals, hire agents backed by different harnesses
(Claude Code, Codex, OpenCode, Gemini CLI, OpenClaw and others), assign them tasks, and watch the
work, approvals and costs from one dashboard. Upstream's framing: if OpenClaw is an employee,
Paperclip is the company.

This template deploys the official upstream image exactly as published. Nothing is rebuilt and
there is no overlay: the manifest moves the data directory onto the volume, points the server at a
managed PostgreSQL and tells it that it is internet-facing. The rest is stock.

The database is a managed `postgres` service, not the embedded PostgreSQL the image can run on its
own. That is upstream's rule rather than a preference: an authenticated deployment with public
exposure refuses to start without `DATABASE_URL` (`StartupRefusalError: database-contract-unmet`).
The compute volume is still needed beside it, for uploads, the instance secret key and the agent
workspaces.

## What you get by hosting it

- An HTTPS dashboard that keeps running when your laptop is closed, which is the point of agents
  that work autonomously.
- A managed PostgreSQL holding the organizations, agents, tasks, runs and approvals, and a
  persistent volume at `/data` holding the instance secret key, uploads and the agent workspaces.
- Session and tool-action signing secrets minted for you and stored as managed secrets.
- The bundled agent CLIs (`claude`, `codex`, `opencode`, `gemini`, `kimi-code`) already installed
  in the image, so the `*_local` adapters can run without any further setup once you supply a
  provider key.

## What you need before deploying

- Nothing. The template declares no required variables.
- A model provider key before agents can do any work. Paperclip's own new-agent flow will not
  finish without one: it asks for a Claude or OpenAI subscription login or an API key before it
  will create the agent. Supply the key as an optional variable here, or enter it in the app.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | optional | Anthropic key. Enables the bundled `claude` CLI as the `claude_local` adapter. From <https://console.anthropic.com>. |
| `OPENAI_API_KEY` | optional | OpenAI key. Enables the bundled `codex` CLI as the `codex_local` adapter. From <https://platform.openai.com>. |
| `GEMINI_API_KEY` | optional | Google key **restricted to the Gemini API** in the Google Cloud console. Unrestricted keys are blocked by Google and `gemini_local` runs fail with an auth error. |
| `PAPERCLIP_AUTH_DISABLE_SIGN_UP` | optional | Set to `true` to close account self-registration. Leave it unset for the first deploy: accepting the first-admin invite creates an account, and that needs sign-up open. |
| `DATABASE_URL` | platform | Bound to the managed `postgres` service this template declares. |
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
the process (its plugin job scheduler logs a 30-second tick at startup), so an idle machine would
never wake for them. Always-on bills continuously.

## After deploy

1. **Mint the first-admin invite.** A fresh instance has no admin, and on a public instance
   upstream deliberately refuses to let a browser claim one, so the link has to be created from
   inside the machine. Upstream's own `paperclipai auth bootstrap-ceo` reads a `config.json` that a
   container configured purely from environment variables never writes, so run the rows it would
   have written instead:

   ```bash
   insta compute exec paperclip -- node --input-type=module -e 'import{createHash,randomBytes}from"node:crypto";import{createRequire}from"node:module";const pg=createRequire("/app/packages/db/package.json")("postgres");const t="pcp_bootstrap_"+randomBytes(24).toString("hex");const s=pg(process.env.DATABASE_URL,{max:1});await s`update invites set revoked_at=now(),updated_at=now() where invite_type=${"bootstrap_ceo"} and revoked_at is null and accepted_at is null`;await s`insert into invites (invite_type,token_hash,allowed_join_types,expires_at,invited_by_user_id) values (${"bootstrap_ceo"},${createHash("sha256").update(t).digest("hex")},${"human"},${new Date(Date.now()+2.592e8)},${"system"})`;console.log(process.env.PAPERCLIP_PUBLIC_URL+"/invite/"+t);await s.end()'
   ```

   It prints one URL, good for 72 hours. The URL is the credential: treat it like a password.

2. Open that URL, choose **Create account**, and set your name, email and password. Better Auth's
   default minimum password length is 8 characters.

3. Name your organization when the onboarding wizard asks. You can leave the wizard at that point
   and go straight to the dashboard; its remaining steps need a model credential.

4. Set `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` on the service and restart if you do not want anyone
   else registering an account. A stranger who signs up has no access to your organization, but
   they do get a login.

5. Add a model provider key, then create an agent and give it a task.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. Upstream publishes a two-architecture index for
  this tag and nothing is rebuilt here.
- Upstream: <https://github.com/paperclipai/paperclip>
- Image: <https://github.com/paperclipai/paperclip/pkgs/container/paperclip> (`ghcr.io/paperclipai/paperclip:2026.1005.0`)
- Documentation: <https://docs.paperclip.ing>
- License: MIT (upstream `paperclipai/paperclip`, LICENSE is the standard MIT text).
