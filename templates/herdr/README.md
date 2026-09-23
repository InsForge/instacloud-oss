# Herdr

Browser terminal workspace for running coding agents.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://console.instacloud.com/templates/herdr)

## Overview

This template runs [herdr](https://github.com/herdrdev/herdr) behind a browser terminal. You open a
URL, authenticate, and land directly in herdr: a terminal workspace manager built for coding
agents, with tmux-style prefix keys, a clickable sidebar, split panes, and a per-pane working /
blocked / idle marker so a stopped agent says so.

herdr speaks no HTTP of its own. Its interface is a TUI and its API is a unix socket, so this image
adds [ttyd](https://github.com/tsl0922/ttyd) in front of it: ttyd is the long-running process that
owns the port and answers the health check, and herdr is what it launches for each connection.

herdr keeps its terminals in a background server that outlives the client, which is what makes it
work in a browser at all. Closing the tab detaches instead of killing the work, and the next
connection reattaches to the same panes.

**No coding agent is preinstalled.** herdr owns terminals, it does not wrap or replace the agents
that run in them, and picking one for you would be picking wrong for someone. The image ships
Node 24, npm, git, ripgrep and an ssh client, with npm's global prefix pointed at the volume, so
`npm install -g @anthropic-ai/claude-code` (or codex, or opencode) from inside the terminal
installs once and survives restarts.

The image is built from the Dockerfile in this directory: `node:24-bookworm-slim` (pinned by
digest), ttyd 1.7.7 and the upstream `herdr-linux-*` 0.9.1 release binary, both verified against
pinned SHA-256 checksums that are upstream's own. Nothing floats on `latest`, so a restart gives
you the same environment.

## What you get by hosting it

- An HTTPS URL for the workspace, with no port forwarding, tunnel or SSH hop to manage. herdr's own
  answer to a dropped SSH connection is that the server keeps running; here there is no SSH
  connection to drop.
- A persistent volume mounted at `/data`. `HOME` is `/data/home`, so herdr's config, its saved
  layout, your cloned repositories, your agent's credentials and anything you `npm install -g`
  survive restarts, redeploys and version upgrades.
- The terminal credentials kept as service variables rather than baked into the image, so you can
  change them later without rebuilding anything. They are yours, not ours: the template ships no
  credential of its own, and both values are visible in the deploy form and in the service's
  variables.
- Deploys are health-gated: a container that does not answer is rolled back to the last healthy
  image instead of leaving you with a dead URL.

## What you need before deploying

- A username and a password of your choosing for the terminal sign-in. There is no default: the
  deploy form starts with both fields empty and will not submit until you fill them.
- A model provider key if you want one present from the first boot. Optional, and not herdr's:
  herdr calls no model. Panes inherit the service environment, so a key set here is already in
  place for whichever agent you start inside it.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | HTTP basic-auth username for the terminal. You choose it; it may not contain a colon. |
| `ADMIN_PASSWORD` | yes | HTTP basic-auth password for the terminal. You choose it. |
| `ANTHROPIC_API_KEY` | no | Anthropic key. Read by Claude Code and other Anthropic clients you run inside herdr. |
| `OPENAI_API_KEY` | no | OpenAI key. Read by Codex and other OpenAI clients you run inside herdr. |

Both credentials are required and neither has a default, so the deploy form starts empty and
refuses to submit until you supply them. Together they must stay under 186 bytes
(`username:password`): past that, ttyd 1.7.7 starts normally and then answers 401 to everyone
including you, so the entrypoint stops the container rather than leaving you with an unreachable
terminal.

Set by the template, not by you: `HOME=/data/home` (puts herdr's config, saved layout and your home
directory on the volume), `SHELL=/bin/bash` (what a new pane runs), `NPM_CONFIG_PREFIX` and `PATH`
(so a global npm install lands on the volume instead of in an image layer).

On the first boot only, when the volume carries no config yet, the entrypoint writes
`$HOME/.config/herdr/config.toml` with one setting: `update.version_check = false`. It is yours to
edit afterwards, and herdr's own settings UI writes to the same file. The reason is that
`herdr update` would replace `/usr/local/bin/herdr`, which is in the image layer and not on the
volume, so the new binary would disappear at the next restart. Upgrade by deploying a newer version
of this template instead.

**Pick the password like it guards a shell, because it does.** What it protects is a root shell
that can run anything and holds whatever API keys and repository access you gave it, so whoever has
the URL and this password has all of that. Both fields can be changed later from the service's
variables.

**The credential is kept out of the service log.** ttyd 1.7.7 prints it at startup by default, as
base64 of `username:password`, which anyone who can read your project's logs could reverse. This
image runs ttyd with `-d 3`, so only errors and warnings are logged. The trade is that a healthy
boot logs one line from the entrypoint and nothing else: ttyd's per-request access lines are gone
too. A container that fails to start still says why.

## After deploy

1. Open the service URL. The browser asks for HTTP basic auth: the `ADMIN_USERNAME` and
   `ADMIN_PASSWORD` you deployed with.
2. You land in herdr, in `/data/home`. First run shows a short welcome screen and an optional
   agent-integration step; `?` lists the keybinds and settings at any time, `ctrl+b` enters prefix
   mode, and the sidebar is clickable.
3. Install the agent you want, once: `npm install -g @anthropic-ai/claude-code`. `NPM_CONFIG_PREFIX`
   is on the volume, so it is still there after a restart.
4. Clone your repository under `/data` (`/data/home/myrepo` is the obvious place) and run the agent
   in a pane. Files written outside `/data` are lost when the container is replaced.
5. Close the tab whenever you like. The panes keep running in herdr's background server; reopening
   the URL reattaches to them. `ctrl+b q` detaches on purpose, and quitting the client leaves you a
   plain shell where `herdr` reattaches.
6. Drive it from a script or an agent with the CLI over herdr's socket API: `herdr pane list`,
   `herdr agent list`, `herdr api snapshot`, `herdr workspace create`. See
   [the socket API docs](https://herdr.dev/docs/socket-api/).

**What a restart does and does not keep.** This service is not always-on, so an idle box with no
browser attached is stopped, and stopping ends the processes in the panes. herdr saves the layout
and restores it on the next attach; the commands that were running in it do not come back, and
upstream says the same in [session state](https://herdr.dev/docs/session-state/). Long agent runs
want a browser left open, or a repository and a prompt you can pick up again.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. The node base image is a multi-arch index, the
  ttyd 1.7.7 release ships both assets, and upstream publishes `herdr-linux-aarch64` beside
  `herdr-linux-x86_64`, each with its own checksum in the Dockerfile.
- Upstream: <https://github.com/herdrdev/herdr>
- Documentation: <https://herdr.dev/docs/>
- ttyd: <https://github.com/tsl0922/ttyd>
- License: Apache-2.0 (upstream).
