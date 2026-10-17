# Odysseus

Self-hosted AI workspace for chat, agents and research.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/odysseus)

## Overview

[Odysseus](https://github.com/odysseus-dev/odysseus) is a single self-hosted application that puts
chat with models, tool-using agents, multi-step web research, a writing editor, an IMAP mailbox,
notes, tasks and a calendar behind one login. It talks to any OpenAI-compatible API and to Ollama,
and it keeps the conversations, documents, mail and accounts in a SQLite database and a file tree it
owns rather than in a vendor's.

This template runs upstream's official image unmodified. There is no overlay Dockerfile in this
directory and no code in this repository between you and the app: the two things that would
otherwise need patching, the data path and the uid the container drops to, are both environment
variables upstream already reads.

What it is not: a managed model host. Nothing runs inference on the deployed machine by default.
Odysseus is the workspace, and the model comes from a provider key you add or an Ollama server you
point it at.

## What you get by hosting it

- Chats, agent runs, research reports, documents, notes and mail on a volume you own.
- One interface over several providers at once: add OpenAI, OpenRouter, any OpenAI-compatible
  gateway and a remote Ollama, and switch model mid-conversation.
- Agents with real tools. The image carries Chromium, a browser automation wrapper, git, a Python
  and Node toolchain and a shell, so an agent can browse, run code and edit files in its workspace
  without a second service.
- Deep Research: a multi-step loop that searches, reads sources and writes a report with citations.
- Email, notes, tasks and a CalDAV-syncing calendar in the same place as the chat that drafts
  against them.
- Per-account auth with TOTP two-factor, and API tokens for external callers.

## What you need before deploying

- A username and a password for the first admin account. Both are deploy-form fields, neither has a
  default or a generator, and the password has to be at least 8 characters. Upstream does mint a
  random password when the variable is absent and print it to the container log, but you will not
  reach that path here: the variable is required, so an empty field stops the deploy before anything
  starts. Choose a password at the prompt and keep it, because nothing can read it back afterwards.
- An API key for whichever model provider you want to chat with, if you want the first chat to work
  straight away. `OPENAI_API_KEY` is optional and keys for any provider can be added in the app
  afterwards.
- A SearXNG instance, or a key for one of the search providers the app supports, if you want web
  search and Deep Research. Upstream's compose file ships a SearXNG container for this; nothing is
  deployed alongside this template, so point `SEARXNG_INSTANCE` at one you run or configure a
  key-based provider in the app.
- Nothing else. The database is SQLite on the volume.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `ODYSSEUS_ADMIN_USER` | yes | Username for the first admin account, created on first boot. Lowercased by the app, and not one of the names it reserves; `admin` is fine. |
| `ODYSSEUS_ADMIN_PASSWORD` | yes | Password for that account, at least 8 characters. Pick one now; the app has no way to show it to you later. |
| `OPENAI_API_KEY` | no | OpenAI API key, so the first chat works without a settings visit. Seeds the first boot; afterwards keys live in the app's own encrypted vault under Settings > Integrations. |
| `OLLAMA_BASE_URL` | no | Base URL of an Ollama server to use for local models, reachable from this instance. Leave blank unless you run one. |
| `SEARXNG_INSTANCE` | no | Base URL of a SearXNG instance for web search and Deep Research. Leave blank to configure a key-based search provider in the app instead. |

Both required variables are read exactly once, by the app's `setup.py`, on the first boot. It writes
a bcrypt hash into `auth.json` on the volume and never reads the variables again, so editing either
one later changes nothing. Change the password in the app, under Settings.

Fixed by the template:

- `ODYSSEUS_DATA_DIR=/data` puts the whole persisted tree on the volume: the SQLite database, the
  auth file, uploads, the gallery, skills, the local embedding cache and the per-feature caches.
  Upstream reads this variable in exactly one module and derives every other path from it, so this
  single value is the whole story. `DATABASE_URL` is deliberately left unset, because its default is
  `sqlite:///<data dir>/app.db` and it follows.
- `PUID=0` and `PGID=0`. The image's entrypoint drops privileges with `gosu` and defaults to
  `1000:1000`, which is the right answer for a bind mount on a developer's laptop. Here the volume
  is created owned by the image's user, which is root, and the entrypoint repairs ownership only on
  the paths it knows about inside `/app`, so a uid 1000 process cannot write its own database. That
  is measured, not assumed: the same manifest with these two lines removed fails the deploy with
  `sqlite3.OperationalError: unable to open database file` and never reaches the health check.
  Running as the uid that owns the volume is the escape hatch upstream already provides. The cost is
  that the app's shell tool and its agents run as root inside the container; the container is the
  boundary either way, but it is worth knowing before you share the instance.
- `AUTH_ENABLED=true` and `LOCALHOST_BYPASS=false`, the values upstream's own security notes ask for
  on anything network-accessible. The workspace includes a shell tool, so an instance with auth off
  hands a shell to whoever has the URL.
- `SECURE_COOKIES=true` marks the session cookie Secure. Left unset the app follows the request
  scheme, and it sees plain HTTP from the edge proxy rather than the HTTPS the browser used.
- `ALLOWED_ORIGINS` and `OAUTH_REDIRECT_BASE_URL` are both the service's own URL. The first is CORS,
  whose default is a localhost pair that suits upstream's compose file and not this; the UI is
  served from the same origin either way, so this is what lets an external or mobile client call the
  API. The second is the callback origin handed to a remote MCP server during its OAuth flow, which
  the container cannot work out for itself because it only ever sees port 7000. If you put the
  instance behind your own domain, edit both on the service and restart.

The service listens on port 7000 and is health-checked on `/api/health`, which is one of the handful
of paths the app's auth middleware exempts. `/` is not: unauthenticated it answers a 302 to `/login`,
which an HTTP health gate reads as a failure.

It is declared `alwaysOn: false`. Chat, research, the editor and the agent loop are all driven by an
inbound request, which is itself what wakes the machine. The app does run a task scheduler inside
the process, and it seeds a set of housekeeping jobs active on the first boot rather than paused
(tidying sessions, documents and research, consolidating memory, auditing skills), but missing one
of those is a delay rather than a loss: the scheduler pushes an overdue active task's next run
forward by 60 seconds at startup, so anything skipped while the machine was down fires a minute
after it wakes. What an idle machine genuinely misses is the time-sensitive work: IMAP mail polling,
note and calendar reminders, and any scheduled agent task you create. Set it to `true` if you
configure any of those.

Nothing is deployed alongside this service. Upstream's compose file also starts SearXNG, ChromaDB
and ntfy; the app degrades without them rather than failing, falling back to its own local embedding
store for retrieval and leaving web search unconfigured until you supply a provider.

## After deploy

1. Open the service URL. Unauthenticated it redirects to the login page.
2. Sign in with `ODYSSEUS_ADMIN_USER` and `ODYSSEUS_ADMIN_PASSWORD`.
3. Open **Settings > Integrations** and add a model provider: a key for OpenAI or any
   OpenAI-compatible gateway, or the URL of an Ollama server. The deploy-form `OPENAI_API_KEY` does
   this for you on the first boot if you supplied one.
4. Pick a model at the top of a new chat and send a message.
5. For web search and Deep Research, set a SearXNG URL or a search provider key under the same
   settings page.
6. Change the admin password under **Settings**, and turn on two-factor there if the instance is
   shared.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. Upstream's index carries both; nothing is rebuilt
  here.
- Upstream: <https://github.com/odysseus-dev/odysseus>
- Documentation: <https://github.com/odysseus-dev/odysseus/blob/main/website/setup.md>
- Image: `ghcr.io/odysseus-dev/odysseus`
- License: AGPL-3.0-or-later.
  <https://github.com/odysseus-dev/odysseus/blob/main/LICENSE>
