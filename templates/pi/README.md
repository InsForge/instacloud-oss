# Pi Coding Agent

Coding agent CLI with session history and a browser terminal.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/pi)

## Overview

This template runs the [Pi coding agent](https://github.com/earendil-works/pi) inside a container
that exposes a browser terminal. You open a URL, authenticate, and get a `bash` shell with the `pi`
CLI already installed. Upstream describes it as a coding-agent CLI with read, bash, edit and write
tools plus session management: so a session you start now can be picked up later from the same
URL.

The image is built from the Dockerfile in this directory: `node:24-bookworm-slim` (pinned by digest)
plus [ttyd](https://github.com/tsl0922/ttyd) 1.7.7 (verified against a pinned SHA-256) and
`@earendil-works/pi-coding-agent` pinned to an exact version. Nothing floats on `latest`, so a
restart gives you the same environment. In front of ttyd sits the InstaCloud sign-in page,
`insta-gate` from this repository's `gate/`, also verified against a pinned SHA-256. ttyd listens
only inside the container and never receives your credentials. Template versions before 0.8.3 logged the
credential on every start, and upgrading does not remove those lines from the log history: if you
ran one, set a new `ADMIN_PASSWORD` before you upgrade.

## What you get by hosting it

- An HTTPS URL for the terminal, with no port forwarding or tunnel to manage.
- A persistent volume mounted at `/data`. `HOME` is set to `/data/home`, so session history, CLI config
  and any repositories you clone survive restarts, redeploys and version upgrades.
- The terminal credentials kept as service variables rather than baked into the image, so you can
  change them later without rebuilding anything. They are yours, not ours: the template ships no
  credential of its own, and both values are visible in the deploy form and in the service's
  variables.
- Deploys are health-gated: a container that does not answer is rolled back to the last healthy
  image instead of leaving you with a dead URL.
- A terminal that outlives the tab. Every tab attaches to the same tmux session, `main`, so closing
  the tab or dropping the network does not stop an agent mid-task, and opening the URL again picks
  up where it was. The machine itself still scales to zero once nothing is connected, which ends
  the session. To keep agents working with nobody connected, run
  `insta compute always-on on <service>`, which bills for the uptime.
- Common tools preinstalled: git, curl, ripgrep, jq, ssh, rsync, unzip, less, and python3 with
  venv. `gh` comes from the platform toolbox at `/.insta/tools/bin` where the machine has one.

## What you need before deploying

- A username and a password of your choosing for the terminal sign-in. There is no default: the
  deploy form starts with both fields empty and will not submit until you fill them.
- A model provider key if you want it present from the first boot. Any one of the three below is
  enough, and none is also fine: you can add a key from inside the terminal instead.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | Username for the InstaCloud sign-in page in front of the terminal. You choose it. |
| `ADMIN_PASSWORD` | yes | Password for the InstaCloud sign-in page in front of the terminal. You choose it. |
| `ANTHROPIC_API_KEY` | no | Anthropic key, for Claude models. |
| `OPENAI_API_KEY` | no | OpenAI key, for GPT models. |
| `OPENROUTER_API_KEY` | no | OpenRouter key, for whichever model you route to. |

Both credentials are required and neither has a default, so the deploy form starts empty and refuses
to submit until you supply them.

Pi reads a provider key straight from the environment and picks its model accordingly. It recognises
more than thirty providers (Gemini, DeepSeek, Groq, Mistral, Kimi and so on); the three above are
the ones this template puts on the deploy form, and the rest work just as well as service variables
or configured from inside the terminal.

Set by the template, not by you: `HOME=/data/home` (puts your home directory on the volume).

**Pick the password like it guards a shell, because it does.** What it protects is a root shell that
can run anything and holds whatever API keys you gave it, so whoever has the URL and this password
has all of that. Both fields can be changed later from the service's variables.

## After deploy

1. Open the service URL. An InstaCloud sign-in page asks for the `ADMIN_USERNAME` and
   `ADMIN_PASSWORD` you deployed with. The session lasts 30 days, and changing either variable signs
   every browser out.
2. You land in a `bash` shell in `/data/home`.
3. Run `pi`. Configure a model provider key if you did not set one as a variable.
4. Configuration and session history persist. Because `HOME` is on the volume, `~` survives
   restarts, so a session started before a redeploy is still there afterwards.
5. Clone your repository into `/data/home` (or anywhere under `/data`) so your work persists too.
   Files written outside `/data` are lost when the container is replaced.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. The node base image, the ttyd release asset
  and the npm package are all available for both.
- Upstream: <https://github.com/earendil-works/pi>
- Package: [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
- ttyd: <https://github.com/tsl0922/ttyd>
- License: MIT (upstream package).
