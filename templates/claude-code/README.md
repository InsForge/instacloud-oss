# Claude Code

Anthropic's coding agent: edits files, runs commands, browser terminal.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/claude-code)

## Overview

This template runs [Claude Code](https://github.com/anthropics/claude-code), Anthropic's terminal
coding agent, inside a container that exposes a browser terminal. You open a URL, authenticate, and
get a `bash` shell with the `claude` CLI already installed: no local install, no laptop left
running. Claude Code reads and edits files in the workspace, runs commands, and works through
multi-step tasks in the same session.

The image is built from the Dockerfile in this directory: `node:24-bookworm-slim` (pinned by
digest) plus [ttyd](https://github.com/tsl0922/ttyd) 1.7.7 (verified against a pinned SHA-256) and
`@anthropic-ai/claude-code` pinned to an exact version. Nothing floats on `latest`, so a restart
gives you the same environment. ttyd carries one patch: its startup log prints `credential: **`
instead of your sign-in encoded in base64, so reading the service's logs does not reveal the
terminal password. Versions before 0.8.3 logged it on every start, and upgrading does not remove
those lines from the log history: if you ran one, set a new `ADMIN_PASSWORD` before you upgrade.

## What you get by hosting it

- An HTTPS URL for the terminal, with no port forwarding or tunnel to manage.
- A persistent volume mounted at `/data`. `HOME` is set to `/data/home`, so your CLI login, shell
  history, and any repositories you clone survive restarts, redeploys, and version upgrades.
- The terminal credentials kept as service variables rather than baked into the image, so you can
  change them later without rebuilding anything. They are yours, not ours: the template ships no
  credential of its own, and both values are visible in the deploy form and in the service's
  variables.
- Deploys are health-gated: a container that does not answer is rolled back to the last healthy
  image instead of leaving you with a dead URL.

## What you need before deploying

- A username and a password of your choosing for the terminal sign-in. There is no default: the
  deploy form starts with both fields empty and will not submit until you fill them.
- Optionally, an [Anthropic API key](https://console.anthropic.com/): otherwise you sign in from
  inside the terminal with `claude login`, which is the normal path for a Claude subscription.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | HTTP basic-auth username for the terminal. You choose it. |
| `ADMIN_PASSWORD` | yes | HTTP basic-auth password for the terminal. You choose it. |
| `ANTHROPIC_API_KEY` | no | Authenticates the CLI without an interactive login. Leave blank to run `claude login` in the terminal instead. |

Both credentials are required and neither has a default, so the deploy form starts empty and refuses
to submit until you supply them. Together they must stay under 186 bytes (`username:password`):
past that, ttyd 1.7.7 starts normally and then answers 401 to everyone including you, so the
entrypoint stops the container instead of leaving you with an unreachable terminal.

Set by the template, not by you: `HOME=/data/home` (puts your home directory on the volume).

**Pick the password like it guards a shell, because it does.** What it protects is a root shell that
can run anything and holds whatever API keys you gave it, so whoever has the URL and this password
has all of that. Both fields can be changed later from the service's variables.

## After deploy

1. Open the service URL. The browser asks for HTTP basic auth: the `ADMIN_USERNAME` and
   `ADMIN_PASSWORD` you deployed with.
2. You land in a `bash` shell in `/data/home`.
3. Run `claude`. If you did not set `ANTHROPIC_API_KEY`, run `claude login` first and follow the
   prompts.
4. That login persists. Because `HOME` is on the volume, `~/.claude` survives restarts: you do not
   re-authenticate after every deploy.
5. Clone your repository into `/data/home` (or anywhere under `/data`) so your work persists too.
   Files written outside `/data` are lost when the container is replaced.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. The node base image, the ttyd release asset
  and the npm package are all available for both.
- Documentation: <https://code.claude.com/docs>
- Upstream: <https://github.com/anthropics/claude-code>
- Package: [`@anthropic-ai/claude-code`](https://www.npmjs.com/package/@anthropic-ai/claude-code)
- ttyd: <https://github.com/tsl0922/ttyd>
- License: Claude Code is distributed under Anthropic's commercial terms, not an open-source
  license. The Dockerfile and manifest in this directory are part of this repository.
