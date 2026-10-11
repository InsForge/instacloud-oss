# nanobot

Self-hosted personal AI agent with a browser workbench.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/nanobot)

## Overview

[nanobot](https://github.com/HKUDS/nanobot) is an ultra-lightweight, open-source personal AI agent
framework from HKU Data Science Lab. It runs as one long-lived gateway process that holds the agent
loop, its tools, its memory and its scheduler, and puts a browser workbench in front of them: side
by side conversations, visible tool calls and file diffs, a workspace the agent can read and write,
MCP servers, skills, and automations that run on a schedule.

This template runs that gateway and nothing else. It is the upstream application, not an API
written here: everything you see after deploy is nanobot's own WebUI. The overlay exists because
upstream publishes no container image, so the image here installs nanobot's published PyPI wheel
(which already carries the built WebUI), points nanobot's instance root at the persistent volume,
seeds a config that enables the WebUI channel behind your password, and drops privileges the way
upstream's own entrypoint does.

**It brings no model with it.** nanobot is a client: you connect it to Anthropic, OpenAI, an
OpenAI-compatible endpoint or a local model from its own **Settings > Models** page, and that
provider does the inference and bills you for it. A deploy with no provider configured still starts
and still serves the WebUI, which is where you configure one.

## What you get by hosting it

- An HTTPS URL for the nanobot WebUI, behind a password you set at deploy time.
- A persistent volume at `/data` holding the whole instance: `config.json`, session history,
  long-term memory, the WebUI's chat transcripts, saved automations, generated media, logs, and the
  agent's workspace.
- A single always-on process, so automations fire on their schedule and chat-app channels
  (Telegram, Discord, Slack, WeChat, email, Mattermost, Linear and the rest) stay connected without
  anyone opening the browser.
- An agent whose conversations, memory and provider keys sit on infrastructure you control.

## What you need before deploying

- A password for the WebUI sign-in screen. There is no username.
- An API key for whichever model provider you want the agent to use. It is **not** a deploy
  variable: you add it in the app under **Settings > Models** after deploy, which is where nanobot
  keeps it.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_PASSWORD` | yes | The password for the WebUI sign-in screen, and the whole credential: nanobot's sign-in has no username field. It becomes `channels.websocket.tokenIssueSecret` in the instance config, which is the gate in front of an agent that runs shell commands and holds your provider keys. It cannot be read back after deploy, so keep a copy. |

That is the whole deploy form. Providers, models, chat channels, MCP servers, skills and
automations all live in nanobot's own **Settings** pages and are written to `config.json` on the
volume, so a deploy-form copy would only be a second place for the same value to drift from.

Set by the template, not by you: the image starts `nanobot gateway` with `--home /data`, and seeds
`/data/config.json` on first boot with the WebSocket channel enabled on `0.0.0.0:8765`, the
gateway's own control port on loopback, `tools.restrictToWorkspace` on, and remote package installs
from the WebUI off. The seed keeps `${ADMIN_PASSWORD}` as a literal placeholder rather than the
value, so rotating the variable and restarting rotates the password. The file is written once and
never overwritten, so everything you configure in the UI survives a restart and a redeploy.

## After deploy

1. Open the service URL. nanobot serves its WebUI shell and asks for the **WebUI password**: that
   is the `ADMIN_PASSWORD` you typed on the deploy form.
2. Open **Settings > Models**, pick a provider, paste its API key and choose a model. Until you do,
   the gateway logs `Provider/model setup is incomplete` on every start and a conversation cannot
   be answered. This is nanobot's intended first-run path, not a workaround.
3. Start a new topic and send `Hello!`. A normal reply means the provider, the model, the workspace
   and the gateway are working together.
4. Choose a workspace and an access mode from the composer before giving the agent project work.
   The template sets `tools.restrictToWorkspace`, which keeps file tools inside `/data/workspace`.
5. Connect a chat app or create an automation from **Settings** when you want the agent reachable
   or running without the browser open.

## Scope

**The volume is the only copy.** Config, sessions, memory, transcripts and the workspace all sit on
one volume, and nothing here snapshots or replicates it. The provider keys you paste into Settings
are on it too.

**The service is always-on, and bills continuously.** That is deliberate: automations and chat
channels fire from inside the process, and an idle-stopped machine would run none of them with
nothing to wake it. If you only ever use the browser, turn always-on off on the service and the
machine will sleep between visits.

**One instance, one password.** nanobot has no user accounts: the password is the whole access
control, and anyone holding it gets the agent, its shell tool and its workspace.

**No bubblewrap.** nanobot's optional `tools.exec.sandbox` can wrap shell commands in bubblewrap,
which needs `SYS_ADMIN` and an unconfined seccomp profile that a compute machine does not grant, so
the binary is not in this image. Shell commands run unsandboxed inside the container, as they do in
upstream's default Docker setup.

## Links

- Architectures: `linux/amd64` and `linux/arm64`.
- Documentation: <https://nanobot.wiki/docs/latest/getting-started/nanobot-overview>
- Upstream: <https://github.com/HKUDS/nanobot>
- Upstream package: `nanobot-ai` on PyPI (<https://pypi.org/project/nanobot-ai/>). Upstream
  publishes no container image; this template deploys
  `ghcr.io/insforge/insta-oss/templates/nanobot`, built from the `Dockerfile` here.
- License: MIT (see <https://github.com/HKUDS/nanobot/blob/main/LICENSE>).
