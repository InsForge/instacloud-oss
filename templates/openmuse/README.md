# OpenMuse

Personal agent with a browser, terminal, files and work that keeps going.

> **Draft.** Upstream calls itself alpha, and two things here are unverified: chat was never
> exercised against a real CopilotKit Intelligence project key, and the image publishes `amd64`
> only because nobody has run its build on arm64. It stays out of the catalog until both are
> settled.

## Overview

[OpenMuse](https://github.com/CopilotKit/OpenMuse) is a personal-agent application from the
CopilotKit team: a chat surface over an agent that has its own browser, files, durable task plans,
goals and tracking watches, PDF handling and an optional Google workspace. It is built with
CopilotKit React Native and AG-UI, and the same codebase ships as an iOS and Android app.

Upstream publishes no container image. Its only deployable artifact is a Render blueprint that
builds three services from source, so this template builds its own image from a pinned commit (see
`./Dockerfile`). Inside it, nginx serves the Expo web bundle and proxies `/api` to the Node API on
loopback, because a template gets one routed port while upstream's API answers `/` with JSON and
expects its UI to be a separate static site.

Two parts of upstream are not in this image:

- **The browser worker.** It is a second image (`apps/worker/Dockerfile`, Playwright Chromium) and
  a template directory builds exactly one. Upstream's own blueprint documents removing it, and the
  API boots either way. Without it the agent cannot browse pages or take control of a session.
- **The Linux computer.** It drives a Docker engine from inside the container, which a compute
  machine does not have. `COMPUTER_ENABLED` is fixed to `false`.

## What you get by hosting it

- The web app and the API behind one HTTPS URL, with HTTP basic auth in front of both.
- A sample workspace by default: a fictional mailbox, ideas, goals, documents and a finance
  importer, which is the tour upstream's README walks through, with no model key needed.
- A live workspace when you want one, with Google OAuth for Gmail and Calendar.
- A persistent volume at `/data`, holding the PGlite database, imported and filled PDFs, the
  session signing key and the token-encryption key, so a restart keeps your work.
- The task worker running in-process: tracking watches re-check pages on their own schedule and
  SQL leases recover tasks interrupted mid-run, which is why the service is always-on.

## What you need before deploying

- A CopilotKit Intelligence project key. Run `npx copilotkit@latest login` and then
  `npx copilotkit@latest project select`. **The server refuses to start without it**, in every
  mode, before it binds a port, so this is not optional configuration.
- A sign-in username and password of your choosing.
- For a real agent rather than the scripted one: a provider key, and a `MODEL` to match.
- For Gmail and Calendar: a Google OAuth client. Its redirect URI is this service's URL plus
  `/api/google/callback`, which you only know after the first deploy.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | Username for the HTTP basic auth in front of the whole app. You choose it. |
| `ADMIN_PASSWORD` | yes | Its password. You choose it. A sample workspace opens without a key of its own, so this pair is the only thing standing between the internet and an app that reads mail and holds your files. |
| `CPK_INTELLIGENCE_API_KEY` | yes | CopilotKit Intelligence project key, from `npx copilotkit@latest project select`. Server-only; the browser never sees it. |
| `WORKSPACE_MODE` | no | `sample` (default) for the fictional workspace, `live` for real Google data. `live` also needs `OPENMUSE_ACCESS_KEY`. |
| `AGENT_BACKEND` | no | `sample` for the scripted agent, `model` to use `MODEL` and a provider key. Defaults to `sample` in a sample workspace and `model` in a live one. |
| `MODEL` | no | Provider-qualified model id, such as `openai/gpt-5`. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` | no | The key matching `MODEL`'s provider. |
| `OPENMUSE_ACCESS_KEY` | no | The workspace access key the app's own sign-in screen asks for, at least 24 characters. Required when `WORKSPACE_MODE=live`, unused otherwise. |
| `TOKEN_ENCRYPTION_KEY` | no | 32 random bytes in standard base64, encrypting stored Google tokens. Leave it blank: the entrypoint mints one onto the volume on first start and reuses it, because a value that changed on restart would leave the stored tokens undecryptable. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | Google OAuth client for Gmail and Calendar. |

Set by the template, not by you: `HOST=127.0.0.1` and `PORT=8787` (the API binds loopback and
nginx is the public face, which is also what lets a sample workspace run at all: it refuses to
start on any other host), `DATA_DIR=/data/openmuse`, `TASK_WORKER_ENABLED=true`,
`COMPUTER_ENABLED=false`, and `PUBLIC_API_URL` and `ALLOWED_ORIGINS` resolved to the service's own
HTTPS URL, which is what signed document links are built from.

The service is always-on. Tracking watches and interrupted-task recovery run from inside the
process on a schedule, and no inbound request would wake a stopped machine for them.

## After deploy

1. Open the service URL and sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
2. A sample workspace opens straight into chat. A live one asks for `OPENMUSE_ACCESS_KEY` first.
3. In **Goals**, create a goal or a tracking watch; it is stored on the volume and survives a
   restart.
4. In **Mail**, the sample workspace has a seeded thread to read and search.
5. For Gmail and Calendar, add a Google OAuth client whose redirect URI is
   `https://<your-service-url>/api/google/callback`, set `WORKSPACE_MODE=live` and
   `OPENMUSE_ACCESS_KEY`, then connect from **Apps**.

## Links

- Architectures: `linux/amd64` only. Nothing in the build is architecture-specific, but the arm64
  leg has not been run; see the architectures table in the registry README.
- Upstream: <https://github.com/CopilotKit/OpenMuse>, built from commit
  `9ec439fbaa878197d9d44c2aa982cca55676dd68`.
- Image: `ghcr.io/insforge/insta-oss/templates/openmuse`, built from `./Dockerfile` in this
  directory.
- License: MIT (upstream `CopilotKit/OpenMuse`).
