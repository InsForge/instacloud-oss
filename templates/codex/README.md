# Codex

OpenAI's lightweight coding agent in a browser terminal.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/codex)

## Overview

This template runs [Codex](https://github.com/openai/codex), OpenAI's terminal coding agent,
inside a container that exposes a browser terminal. You open a URL, authenticate, and get a `bash`
shell with the `codex` CLI already installed. Upstream describes it as a lightweight coding agent
that runs in your terminal; this template gives that terminal a URL and a disk.

The image is built from the Dockerfile in this directory: `node:24-bookworm-slim` (pinned by digest)
plus [ttyd](https://github.com/tsl0922/ttyd) 1.7.7 (verified against a pinned SHA-256) and
`@openai/codex` pinned to an exact version. The base image, ttyd and the agent CLI are fixed, so
the CLI you get is the one the template version names. The rest is not: every Debian package is installed by name from
Debian's live bookworm repositories, `gh` from upstream's rolling apt repository and `bun` from
npm, so all of them can move between two builds of the same template version. In front of ttyd
sits the InstaCloud sign-in page, `insta-gate` from this
repository's `gate/`, also verified against a pinned SHA-256. ttyd listens only inside the container
and never receives your credentials. Template versions before 0.8.3 logged the credential on every start, and
upgrading does not remove those lines from the log history: if you ran one, set a new
`ADMIN_PASSWORD` before you upgrade.

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
- Optionally, an [OpenAI API key](https://platform.openai.com/api-keys): otherwise you sign in
  from inside the terminal with `codex login`.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | Username for the InstaCloud sign-in page in front of the terminal. You choose it. |
| `ADMIN_PASSWORD` | yes | Password for the InstaCloud sign-in page in front of the terminal. You choose it. |
| `OPENAI_API_KEY` | no | Authenticates the CLI without an interactive login. Leave blank to run `codex login` in the terminal instead. |

Both credentials are required and neither has a default, so the deploy form starts empty and refuses
to submit until you supply them.

Set by the template, not by you: `HOME=/data/home` (puts your home directory on the volume).

**Pick the password like it guards a shell, because it does.** What it protects is a root shell that
can run anything and holds whatever API keys you gave it, so whoever has the URL and this password
has all of that. Both fields can be changed later from the service's variables.

## After deploy

1. Open the service URL. An InstaCloud sign-in page asks for the `ADMIN_USERNAME` and
   `ADMIN_PASSWORD` you deployed with. The session lasts 30 days, and changing either variable signs
   every browser out.
2. You land in a `bash` shell in `/data/home`.
3. Run `codex`. If you did not set `OPENAI_API_KEY`, run `codex login` first and follow the
   prompts.
4. That login persists. Because `HOME` is on the volume, the CLI's config survives restarts: you
   do not re-authenticate after every deploy.
5. Clone your repository into `/data/home` (or anywhere under `/data`) so your work persists too.
   Files written outside `/data` are lost when the container is replaced.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. The node base image, the ttyd release asset
  and the npm package are all available for both.
- Upstream: <https://github.com/openai/codex>
- Package: [`@openai/codex`](https://www.npmjs.com/package/@openai/codex)
- ttyd: <https://github.com/tsl0922/ttyd>
- License: Apache-2.0 (upstream `openai/codex`).
