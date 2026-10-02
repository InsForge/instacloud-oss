# OpenMuse

Personal agent with files, goals, tracking and a live Google workspace.

> **Draft.** Upstream calls itself alpha, and two things here are unverified: chat has not been
> exercised end to end against a real CopilotKit Intelligence project key plus an OpenAI key, and
> the image publishes `amd64` only because nobody has run its build on arm64. It stays out of the
> catalog until both are settled.

## Overview

[OpenMuse](https://github.com/CopilotKit/OpenMuse) is a personal-agent application from the
CopilotKit team: a chat surface over an agent that has its own files, durable task plans, goals and
tracking watches, PDF handling and a Google workspace. It is built with CopilotKit React Native and
AG-UI, and the same codebase ships as an iOS and Android app.

Upstream publishes no container image. Its only deployable artifact is a Render blueprint
(`render.yaml`) that builds three services from source and runs them as a **live** workspace driven
by a real model. This template follows that blueprint: it builds its own image from a pinned commit
(see `./Dockerfile`), and ships the same `WORKSPACE_MODE=live`, `AGENT_BACKEND=model`,
`MODEL=openai/gpt-5` configuration. Inside the image, nginx serves the Expo web bundle and proxies
`/api` to the Node API on loopback, because a template gets one routed port while upstream's API
answers `/` with JSON and expects its UI to be a separate static site.

Two parts of upstream are not in this image:

- **The browser worker.** It is a second image (`apps/worker/Dockerfile`, a Playwright Chromium
  service upstream runs as a private service) and upstream publishes no image for it. A template's
  CI builds exactly one image per directory, so pulling the worker in would mean maintaining a
  separate ~2 GB image outside that build. Upstream's own blueprint documents removing it, and the
  API boots either way. Without it the agent cannot browse pages or take control of a session.
- **The Linux computer.** It drives a Docker engine from inside the container, which a compute
  machine does not have. `COMPUTER_ENABLED` is fixed to `false`.

## What you get by hosting it

- The web app and the API behind one HTTPS URL.
- A live workspace: the agent runs against a real model, and Gmail and Calendar connect through
  Google OAuth.
- A persistent volume at `/data`, holding the PGlite database, imported and filled PDFs, the
  session signing key and the token-encryption key, so a restart keeps your work.
- The task worker running in-process: tracking watches re-check pages on their own schedule and
  SQL leases recover tasks interrupted mid-run, which is why the service is always-on.

## What you need before deploying

- **A workspace access key** of your choosing, at least 24 characters. OpenMuse's own sign-in
  screen asks for it; it is the app's only password.
- **A CopilotKit Intelligence project key.** Run `npx copilotkit@latest login` and then
  `npx copilotkit@latest project select`. **The server refuses to start without it**, before it
  binds a port, so this is not optional configuration.
- **An OpenAI API key**, for the default `MODEL=openai/gpt-5`. To use a different provider, set
  `MODEL` to an `anthropic/*` or `google/*` id and supply that provider's key instead.
- **For Gmail and Calendar:** a Google OAuth client. Its redirect URI is this service's URL plus
  `/api/google/callback`, which you only know after the first deploy.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `OPENMUSE_ACCESS_KEY` | yes | The workspace access key OpenMuse's sign-in screen asks for, at least 24 characters. In live mode this is the whole of the app's auth: it gates `POST /api/session`, and every other call needs the session it mints. You type it into the app. |
| `CPK_INTELLIGENCE_API_KEY` | yes | CopilotKit Intelligence project key, from `npx copilotkit@latest project select`. Server-only; the browser never sees it. |
| `OPENAI_API_KEY` | yes | OpenAI key for the default `MODEL=openai/gpt-5`. |
| `TOKEN_ENCRYPTION_KEY` | no | 32 random bytes in standard base64, encrypting stored Google tokens. Leave it blank: the entrypoint mints one onto the volume on first start and reuses it, because a value that changed on restart would leave the stored tokens undecryptable. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | Google OAuth client for Gmail and Calendar. |
| `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` | no | A provider key for an `anthropic/*` or `google/*` `MODEL`, instead of the OpenAI default. |

Set by the template, not by you: `HOST=127.0.0.1` and the API's port `8787` (the API binds loopback
and nginx is the public face), `WORKSPACE_MODE=live`, `AGENT_BACKEND=model`, `MODEL=openai/gpt-5`,
`DATA_DIR=/data/openmuse`, `TASK_WORKER_ENABLED=true`, `COMPUTER_ENABLED=false`, and
`PUBLIC_API_URL` and `ALLOWED_ORIGINS` resolved to the service's own HTTPS URL, which is what signed
document links and the Google OAuth redirect are built from.

The service is always-on. Tracking watches and interrupted-task recovery run from inside the
process on a schedule, and no inbound request would wake a stopped machine for them.

## After deploy

1. Open the service URL. OpenMuse's sign-in screen asks for the workspace access key; enter
   `OPENMUSE_ACCESS_KEY`.
2. The workspace opens. Chat talks to the agent through your CopilotKit Intelligence project and the
   model you configured.
3. In **Goals**, create a goal or a tracking watch; it is stored on the volume and survives a
   restart.
4. For Gmail and Calendar, add a Google OAuth client whose redirect URI is
   `https://<your-service-url>/api/google/callback`, set `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`, then connect from **Apps**.

## Links

- Architectures: `linux/amd64` only. Nothing in the build is architecture-specific, but the arm64
  leg has not been run; see the architectures table in the registry README.
- Upstream: <https://github.com/CopilotKit/OpenMuse>, built from commit
  `9ec439fbaa878197d9d44c2aa982cca55676dd68`.
- Image: `ghcr.io/insforge/insta-oss/templates/openmuse`, built from `./Dockerfile` in this
  directory.
- License: MIT (upstream `CopilotKit/OpenMuse`).
