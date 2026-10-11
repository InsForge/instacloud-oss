# Claude Code

Anthropic's coding agent: edits files, runs commands, browser terminal.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/claude-code)

## Overview

This template runs [Claude Code](https://github.com/anthropics/claude-code), Anthropic's terminal
coding agent, inside a container that exposes a browser terminal. You open a URL, authenticate, and
get a `bash` shell, inside tmux, with the `claude` CLI already installed: no local install, no
laptop left running. Claude Code reads and edits files in the workspace, runs commands, and works through
multi-step tasks in the same session.

The image is built from the Dockerfile in this directory: `node:24-bookworm-slim` (pinned by digest)
plus [ttyd](https://github.com/tsl0922/ttyd) 1.7.7 (verified against a pinned SHA-256) and
`@anthropic-ai/claude-code` pinned to an exact version, plus tmux and the Debian packages an agent
reaches for first. The base image, ttyd and the agent CLI are fixed, so the CLI you get is the
one the template version names. The rest is not: every Debian package is installed by name from Debian's live bookworm
repositories, `gh` from upstream's rolling apt repository and `bun` from npm, so all of them can
move between two builds of the same template version. In front
of ttyd sits the InstaCloud sign-in page, `insta-gate` from this repository's `gate/`, also verified
against a pinned SHA-256. ttyd listens only inside the container and never receives your
credentials. Template versions before 0.8.3 logged the credential on every start, and upgrading does not
remove those lines from the log history: if you ran one, set a new `ADMIN_PASSWORD` before you
upgrade.

## What you get by hosting it

- An HTTPS URL for the terminal, with no port forwarding or tunnel to manage.
- A persistent volume mounted at `/data`. `HOME` is set to `/data/home`, so your CLI login, shell
  history, and any repositories you clone survive restarts, redeploys, and version upgrades.
  Everything outside the volume is reset from the image on restart. Keep the volume at `/data`: moved
  with `insta compute volume --mount-path`, it no longer holds `HOME`, so the next restart resets
  your home directory.
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
- Common tools preinstalled: `gh`, git, curl, ripgrep, jq, ssh, rsync, unzip, zip, less, tree,
  fzf, htop, nano and vi, python3 with venv and pip, bun, and the C and C++ toolchain that `npm
  install` needs to build a package with a native addon. For working out what is wrong from inside
  the box: lsof, ss, dig, netstat, socat. A machine that mounts the platform toolbox at
  `/.insta/tools/bin` has a second `gh` there, and a git credential helper already pointing at that
  one keeps working.

## What you need before deploying

- A username and a password of your choosing for the terminal sign-in. There is no default: the
  deploy form starts with both fields empty and will not submit until you fill them.
- Optionally, a way for the CLI to sign in without a prompt: an
  [Anthropic API key](https://console.anthropic.com/), or a subscription token you print by running
  `claude setup-token` on your own computer. Otherwise you sign in from inside the terminal with
  `claude login`, which is the normal path for a Claude subscription.
- Optionally, a GitHub token for `gh`, such as the output of `gh auth token` on your own computer.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | Username for the InstaCloud sign-in page in front of the terminal. You choose it. |
| `ADMIN_PASSWORD` | yes | Password for the InstaCloud sign-in page in front of the terminal. You choose it. |
| `ANTHROPIC_API_KEY` | no | Authenticates the CLI without an interactive login. Leave blank to run `claude login` in the terminal instead. |
| `CLAUDE_CODE_OAUTH_TOKEN` | no | Signs the CLI in to your Claude subscription. Print one by running `claude setup-token` on your own computer: it lasts a year and works on every box you deploy. It only makes model requests, so it cannot start Remote Control. Leave blank if you want that, and run `claude login` instead. |
| `GH_TOKEN` | no | Authenticates `gh`, for example with the output of `gh auth token`. Run `gh auth setup-git` once to use it for git over HTTPS too. Leave blank to run `gh auth login` in the terminal instead. |

When both `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are set, the CLI uses the API key.

Both credentials are required and neither has a default, so the deploy form starts empty and refuses
to submit until you supply them.

Set by the template, not by you: `HOME=/data/home` (puts your home directory on the volume), and a
`PATH` that starts with `~/.local/bin`, so tools you install there are found and survive restarts.

**Pick the password like it guards a shell, because it does.** What it protects is a root shell that
can run anything and holds whatever API keys you gave it, so whoever has the URL and this password
has all of that. Both fields can be changed later from the service's variables.

## After deploy

1. Open the service URL. An InstaCloud sign-in page asks for the `ADMIN_USERNAME` and
   `ADMIN_PASSWORD` you deployed with. The session lasts 30 days, and changing either variable signs
   every browser out.
2. You land in a `bash` shell in `/data/home`, inside the tmux session `main`. The mouse wheel
   scrolls back through the output. Hold Shift (Option on a Mac) while dragging to select text.
3. Run `claude`. If you set neither `ANTHROPIC_API_KEY` nor `CLAUDE_CODE_OAUTH_TOKEN`, run
   `claude login` first and follow the prompts.
4. That login persists. Because `HOME` is on the volume, `~/.claude` survives restarts: you do not
   re-authenticate after every deploy.
5. Clone your repository into `/data/home` (or anywhere under `/data`) so your work persists too.
   Files written outside the volume are lost when the container is replaced, and that includes
   packages from `apt-get`. Install extra tools under `~/.local`, for example
   `npm install -g --prefix ~/.local <package>`.
6. SSH gives you the same terminal outside the browser: `insta compute ssh --setup <service>` once,
   then `ssh <service>.insta`, where `tmux attach -t main` joins the session the browser shows. It
   does not give you a port. The platform refuses SSH port forwarding, so `-L`, `-R` and `-D` all
   fail, and the terminal's is the only routed port. A server that has to be reachable from your
   computer belongs in its own compute service.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. The node base image, the ttyd release asset
  and the npm package are all available for both.
- Documentation: <https://code.claude.com/docs>
- Upstream: <https://github.com/anthropics/claude-code>
- Package: [`@anthropic-ai/claude-code`](https://www.npmjs.com/package/@anthropic-ai/claude-code)
- ttyd: <https://github.com/tsl0922/ttyd>
- License: Claude Code is distributed under Anthropic's commercial terms, not an open-source
  license. The Dockerfile and manifest in this directory are part of this repository.
