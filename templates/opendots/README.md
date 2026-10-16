# OpenDots

Self-hosted AI coworkers with shared documents, chat and calls.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/opendots)

## Overview

[OpenDots](https://github.com/CopilotKit/OpenDots) is a personal-agent workspace from the CopilotKit
team. A **Space** is a home for working documents: a searchable library of pages you edit in a
focused editor with formatting, slash commands and autosave. A **Dot** is a specialist agent with a
name, a role, instructions and a set of permitted tools, which you talk to in text or on a call, can
give MCP connections to, and can ask to draft a page that you approve before it is saved. It is
built with CopilotKit and AG-UI, and upstream describes it as an alpha template rather than a
finished product.

Upstream publishes no container image: the repository ships a Dockerfile but nothing builds or
pushes it, and there is no tag or release. This template builds the `app` target of that Dockerfile
from a pinned commit (see `./Dockerfile`). It is the upstream application behind an HTTPS face, not
a reimplementation.

Two parts of upstream are deliberately not here, and both are additions rather than repairs:

- **The isolated browser worker** (upstream's `browser` Dockerfile target, a Playwright Chromium
  service used by `WEB_SEARCH_PROVIDER=browser`). A template directory builds one image, and the
  default `parallel` search provider needs no second service.
- **Dot computers.** Each Dot's own computer is an [OpenBot](https://github.com/CopilotKit/OpenBot)
  container supervisor that creates and `exec`s into containers, which needs a Docker engine a
  compute machine does not provide. `COMPUTER_SUPERVISOR_URL` is left unset, so the Computer panel
  stays unconfigured.

## What you get by hosting it

- The web app behind one HTTPS URL, with a single owner token in front of its whole API.
- Spaces and pages: a document workspace with nested subpages, grid and list views, a visual
  editor, Markdown source mode and autosave. This half works with no third-party key at all.
- Dots: specialist agents with per-Dot instructions and tool permissions, once you supply an
  Intelligence key and a model.
- Optional Slack: mention a Dot through a managed CopilotKit Channels connection, with an explicit
  workspace and user allowlist.
- A persistent volume at `/data` holding the SQLite database: Spaces, pages, Dots, settings,
  memories and scheduled tasks, so a restart keeps your work. Conversation history lives in
  CopilotKit Threads rather than on the volume.
- The scheduled-task runner in-process, firing saved tasks on their own interval, which is why the
  service is always-on.

## What you need before deploying

- **An owner access token** of your choosing, at least 24 characters. OpenDots' sign-in screen asks
  for it; it is the app's only password, and the server refuses to start with a shorter one.
- **For conversations, calls and scheduled tasks:** a CopilotKit Intelligence project key, plus an
  OpenAI-compatible API key and a model id. Run `npx copilotkit@latest login` and then
  `npx copilotkit@latest project select` for the first. Without all three the app still opens and
  the document side works; it reports the missing ones on its own setup screen.
- **For calls:** a realtime speech provider key and model, on top of the three above.
- **For Slack:** a managed Channels declaration name, your Slack workspace id, and the Slack user
  ids allowed to mention your Dots. See upstream's
  [Slack setup](https://github.com/CopilotKit/OpenDots/blob/main/docs/SETUP.md#slack).

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `OWNER_TOKEN` | yes | The owner access token OpenDots' sign-in screen asks for, at least 24 characters. It is the whole of the app's auth: every `/api/*` call is compared against it timing-safely, and the server refuses to start with a shorter one. You type it into the app. |
| `CPK_INTELLIGENCE_API_KEY` | no | CopilotKit Intelligence project key, from `npx copilotkit@latest project select`. Conversations, threads, calls and Slack need it. Server-only; the browser never sees it. |
| `OPENAI_API_KEY` | no | Key for the OpenAI-compatible provider the Dots run on. |
| `OPENAI_MODEL` | no | Model id the Dots run, for example `gpt-5`. The app reports this and `OPENAI_API_KEY` as missing until both are set. |
| `OPENAI_BASE_URL` | no | OpenAI-compatible endpoint when the provider is not OpenAI itself. Defaults to `https://api.openai.com/v1`. |
| `WEB_SEARCH_PROVIDER` | no | `parallel` (the default, anonymous MCP for light use), `browser` (needs a browser service this template does not deploy), or `disabled`. |
| `PARALLEL_API_KEY` | no | Bearer key for Parallel, for production rate limits. |
| `VOICE_API_KEY` / `VOICE_MODEL` / `VOICE_NAME` | no | Realtime speech for calls. Calls stay off until the key and the model are both set. `VOICE_NAME` defaults to `marin`. |
| `SLACK_CHANNEL_NAME` / `SLACK_TEAM_ID` / `SLACK_USER_IDS` / `SLACK_DOT_ID` | no | Managed Slack connection and its allowlist. `SLACK_CHANNEL_NAME` is the Channels declaration name, not a Slack `#channel` name. |
| `COPILOTKIT_TELEMETRY_DISABLED` | no | Set to `true` to switch off the CopilotKit SDK's usage telemetry, which is on by default and is separate from conversation data. |

Set by the template, not by you: `HOST=0.0.0.0` (the platform proxy reaches the service over the
network, which is also what makes `OWNER_TOKEN` mandatory upstream),
`DATABASE_PATH=/data/opendots.sqlite`, `OWNER_ID=opendots-owner`, and `APP_ORIGIN` resolved to the
service's own HTTPS URL. That last one matters: left unset, the server falls back to the origin it
reconstructs from the request, which behind the platform's TLS terminator is the `http://` form of
the same host, and every browser call would be refused as cross-origin.

The service is always-on. The scheduled-task runner fires from inside the process, and no inbound
request would wake a stopped machine for it.

## After deploy

1. Open the service URL. The sign-in screen asks for the owner access token; paste `OWNER_TOKEN`.
2. The workspace opens. Pick a Space, create a page, and write in it. Autosave reports its progress,
   and the page is on the volume, so it survives a restart.
3. If you set the Intelligence key, the model key and the model id, the Dots answer: open a Dot,
   ask it something, and it can draft a page for you to approve before it is saved. Without them the
   app's setup screen names exactly which of the three is missing.
4. For Slack, add the Channels declaration name, your workspace id and the user ids allowed to
   mention a Dot, then restart the service.

## Links

- Architectures: `linux/amd64` only. Nothing in the build is architecture-specific, but the arm64
  leg has not been run; see the architectures table in the registry README.
- Upstream: <https://github.com/CopilotKit/OpenDots>, built from commit
  `625452e06cde74cb25b0ce319e2c1be0488f5a5f`.
- Image: `ghcr.io/insforge/insta-oss/templates/opendots`, built from `./Dockerfile` in this
  directory.
- License: MIT (upstream `CopilotKit/OpenDots`).
