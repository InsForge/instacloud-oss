# OpenBot

Self-hosted AI coworkers with a browser, a shell and an audit trail.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/openbot)

> **Have a CopilotKit Intelligence key ready.** OpenBot will not boot without one, and the
> deploy form asks for it. A free plan covers it: sign in at
> [intelligence.copilotkit.ai](https://intelligence.copilotkit.ai) and copy the `cpk-...`
> runtime key. Full steps under [What you need before deploying](#what-you-need-before-deploying) below.

## Overview

[OpenBot](https://github.com/CopilotKit/openbot) is CopilotKit's open-source platform for AI
coworkers: the shape of ChatGPT or Claude, running on infrastructure you own. Each coworker is any
endpoint speaking [AG-UI](https://github.com/ag-ui-protocol/ag-ui), so a Bot can be written on
LangGraph, Mastra, CrewAI, Pydantic AI or by hand and still arrives the same way. Thirteen ship
configured in the example tenant package, including a general assistant and ten single-job
coworkers under `examples/fintech/`.

What makes it different from a chat window is the gateway. Anything a Bot does to a browser, a
file, an MCP server or a component is resolved, decided against a CEL policy, written to the audit
trail, and only then acted on, so `/admin/audit` lists what was permitted, what was refused and
which rule refused it.

This template deploys upstream's own one-container image, which carries the app, the API, Chromium
and an optional PostgreSQL. `./Dockerfile` adds two things and rebuilds none of it:

- **A sign-in.** OpenBot's `OPENBOT_SINGLE_USER` mode admits every request as one administrator and
  upstream refuses to start when it is combined with an address the public internet reaches. The
  only other way in upstream offers is an OAuth client registered against a redirect URI that
  cannot be known before the deploy exists. So the routed port is Caddy, doing HTTP basic auth and
  proxying to the API on loopback, and OpenBot keeps the loopback-only listener it is happy with.
- **A stable encryption key.** `KEY_ENCRYPTION_KEY` has to be the base64 of exactly 32 bytes and
  has to be the same value on every boot, or the credential vault stops decrypting. It is
  generated once onto the volume at first start, beside where upstream keeps the embedded cluster's
  own password.

## What you get by hosting it

- An HTTPS URL serving the app and its API from one origin, behind a username and password you
  choose at deploy time.
- One shared computer for the Bots: a real Chromium they drive, plus a shell they can run commands
  in, both inside this container and reachable from nowhere else.
- The audit trail, the boundary policy and the credential vault in a PostgreSQL that runs in the
  same container and keeps its data on the volume.
- Admin surfaces for all of it: `/admin/audit`, `/admin/boundaries`, `/admin/credentials`,
  `/admin/computers`, `/admin/plugins`, `/admin/skills`.

## What you need before deploying

- **A CopilotKit Intelligence runtime key** (`cpk-...`). Sign in at
  [intelligence.copilotkit.ai](https://intelligence.copilotkit.ai), or run
  `npx --yes copilotkit@latest login` and then `npx --yes copilotkit@latest project select`, which
  prints it. A free plan is available. Intelligence owns durable threads and memory, and upstream
  refuses to start without the key: there is no degraded mode.
- **An OpenAI API key**, or another endpoint speaking `/v1/chat/completions` named in
  `OPENAI_BASE_URL`. The shipped Bots read it from the environment, so there is no page in the app
  that can supply it later.
- **A username and password** for the sign-in in front of the app. Pick them at the deploy prompt.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | Username for the sign-in in front of OpenBot. Letters, digits, `.`, `-` and `_` only, because it is written into the proxy's config as one token. |
| `ADMIN_PASSWORD` | yes | Password for that sign-in. At most 72 bytes, which is all bcrypt reads; a longer one is refused at start rather than silently truncated. |
| `INTELLIGENCE_API_KEY` | yes | The `cpk-...` runtime key of your Intelligence project. Threads and memory live there. |
| `OPENAI_API_KEY` | yes | The key the shipped Bots spend on model calls. |
| `OPENAI_BASE_URL` | no | An endpoint speaking OpenAI's `/v1/chat/completions`, if the key above is not OpenAI's. Model names travel verbatim. |
| `KEY_ENCRYPTION_KEY` | no | Base64 of 32 bytes (`openssl rand -base64 32`), encrypting the credential vault at rest. Leave it blank and one is generated on the volume at first boot and reused after that. Changing it later makes everything already stored unreadable. |
| `COMPOSIO_API_KEY` | no | A Composio key, if you want its connector catalogue on the Plugins page. The built-in connectors need no key. |

Set by the template, not by you: `EMBEDDED_POSTGRES=on` (the database runs in this container and
keeps its data on the volume; upstream runs migrations only in this mode),
`OPENBOT_SINGLE_USER=true` with the proxy above in front of it, the two managed Intelligence
addresses, and `PROXY_PORT=8080`.

`OPENBOT_PUBLIC_URL`, `OPENBOT_APP_URL` and `TRUSTED_ORIGINS` are deliberately left unset: they are
the three values upstream reads to decide whether single-user mode is being published to the
internet, and none of them is used here, because the app is served same-origin by the API and
trusted origins are read only when an identity provider is configured.

The volume mounts at `/var/lib/postgresql`, not at `/data`. That is upstream's instruction: the
cluster's data directory is `/var/lib/postgresql/data`, and a volume mounted directly on it arrives
holding a `lost+found`, which `initdb` refuses to initialise into.

The service is not always-on. A browser opening the URL is itself the inbound request that wakes
it, and nothing in this image is scheduled: upstream's routines sweep and its staged-attachment
sweep are both external cron jobs a one-container deployment does not run.

## After deploy

1. Open the service URL and sign in with the username and password you chose.
2. Go to `/bot` and ask it something. `Open news.ycombinator.com and tell me the top story.` makes
   it use the browser, which is the part worth seeing first.
3. Open `/admin/audit`. Every browser action the Bot just took is a row, with the decision that
   allowed it.
4. Open `/admin/boundaries`, add a deny rule, and ask for the same thing again. It is refused and
   the refusal names the rule.
5. Create a coworker of your own from `/agents`, or point one at an AG-UI endpoint you already run.

Two things this deployment does not carry, both by upstream's design for the one-container image:

- **The supervisor**, which gives each Bot its own container. It needs a Docker socket. Without it
  every Bot shares the one browser, so they share its logins, its files and its session.
- **Routines.** A routine can be created and its next run time is computed, but nothing in the
  image fires it, so it never runs.

A Bot's files and browser profiles are in the container, not on the volume, so they are as durable
as the container. The database, which holds the audit trail, the policy and the vault, is on the
volume.

## Links

- Upstream: <https://github.com/CopilotKit/openbot>, pinned at `v0.0.15`
- Deployment notes, including the minimum sizes:
  <https://github.com/CopilotKit/openbot/blob/main/docs/deployment.md>
- Upstream image: `ghcr.io/copilotkit/openbot`, wrapped by `./Dockerfile` and published as
  `ghcr.io/insforge/insta-oss/templates/openbot`
- Proxy: [Caddy](https://github.com/caddyserver/caddy) 2.11.6, Apache-2.0
- License: MIT (upstream `CopilotKit/openbot`)
