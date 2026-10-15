# Superset

A remote host for Superset coding-agent workspaces, with a browser terminal of its own.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/superset-sh)

## Overview

[Superset](https://github.com/superset-sh/superset) runs Claude Code, Codex, or another CLI agent
in parallel git worktrees, with terminals, a diff viewer and browser previews around them. The
product itself is a macOS and Linux **desktop app**, which a container cannot run, so this template
is not that: it packages upstream's **standalone `superset` CLI**, the one piece of Superset that is
built to run headless.

That CLI carries the host service. Sign in on this box and run `superset start --daemon`, and the
machine registers with the Superset relay as a **host**: your desktop app, the CLI on your laptop,
and the iPhone app can then open workspaces whose files, terminals and agent runs live here instead
of on your own computer. Upstream's own remote-access guide recommends exactly this shape, a
separate machine holding only the repositories and credentials you mean to share, rather than
exposing your workstation.

Two things it is not. It is not a web UI for Superset: upstream ships none, and this template writes
none. The page you open is a browser terminal, and the desktop or mobile app is still the interface.
It is also not a copy of superset.sh: the CLI talks to upstream's own hosted API and relay, so an
account there is what makes the host half work at all.

The image is built from the Dockerfile in this directory: `node:24-bookworm-slim` (pinned by
digest), [ttyd](https://github.com/tsl0922/ttyd) 1.7.7 (verified against a pinned SHA-256), and
upstream's own `superset-linux-*.tar.gz` release asset, verified against a pinned SHA-256 per
architecture and unpacked unmodified. In front of ttyd sits the InstaCloud sign-in page,
`insta-gate` from this repository's `gate/`, also verified against a pinned SHA-256. ttyd listens
only inside the container and never receives your credentials.

## What you get by hosting it

- A machine that can hold your Superset workspaces, so agents keep working when your laptop is
  closed, asleep or somewhere else.
- An HTTPS URL for a `bash` terminal on that machine, with no port forwarding or tunnel to manage.
- A persistent volume mounted at `/data`. `HOME` is set to `/data/home`, so `~/.superset` (your
  Superset login, the host database, its logs, installed plugins), every agent CLI's own config,
  and any repository you clone survive restarts, redeploys and version upgrades.
- Automatic re-registration: set `SUPERSET_API_KEY` and the container runs `superset start --daemon`
  on every boot, so a restart brings the host back online without anyone opening the terminal.
- The terminal credentials kept as service variables rather than baked into the image, so you can
  change them later without rebuilding anything. They are yours, not ours: the template ships no
  credential of its own.
- A terminal that outlives the tab. Every tab attaches to the same tmux session, `main`, so closing
  the tab or dropping the network does not stop an agent mid-task.
- Common tools preinstalled: `gh`, git, curl, ripgrep, jq, ssh, rsync, unzip, zip, less, tree, fzf,
  htop, nano and vi, python3 with venv and pip, bun, and the C and C++ toolchain that `npm install`
  needs to build a package with a native addon. For working out what is wrong from inside the box:
  lsof, ss, dig, netstat, socat.

## What you need before deploying

- A username and a password of your choosing for the terminal sign-in. There is no default: the
  deploy form starts with both fields empty and will not submit until you fill them.
- A **Superset account** at <https://app.superset.sh>, for anything beyond the plain terminal. The
  CLI authenticates against upstream's hosted API, and without an account `superset start` has
  nothing to register with.
- **Remote access is a Superset Pro feature.** Reaching this host from another device is the
  capability this template exists for, and upstream gates it; check your plan before deploying.
- Optionally, a Superset API key from **Settings -> API Keys** in the desktop app, if you want the
  box to register itself rather than signing in by hand.
- No coding agent is preinstalled. Superset supports around twenty of them and picking one here
  would be arbitrary, so install the one you use from the terminal, for example
  `npm install -g @anthropic-ai/claude-code`. The install lands under `HOME`, so it survives a
  restart.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | Username for the InstaCloud sign-in page in front of the terminal. You choose it. |
| `ADMIN_PASSWORD` | yes | Password for the InstaCloud sign-in page in front of the terminal. You choose it. |
| `SUPERSET_API_KEY` | no | Superset API key (`sk_live_…`) from Settings -> API Keys. Set it and the box registers itself as a host on every boot. Leave blank and run `superset auth login` in the terminal instead. |
| `SUPERSET_ORGANIZATION_ID` | no | Which organization the host registers under, as an id, slug or name. Only needed when your API key reaches more than one, because the CLI will not guess. |

Both credentials are required and neither has a default, so the deploy form starts empty and refuses
to submit until you supply them.

Set by the template, not by you: `HOME=/data/home` (puts your home directory, and with it
`~/.superset`, on the volume).

**Pick the password like it guards a shell, because it does.** What it protects is a root shell that
can run anything and holds whatever credentials you gave it, so whoever has the URL and this
password has all of that. Both fields can be changed later from the service's variables.

This template deploys **always-on**, unlike the other terminal templates here. `superset start`
holds an outbound connection to the relay and waits on it, so a desktop app reaching this host
arrives through that connection and never sends the inbound request a scale-to-zero machine needs
in order to wake. An idled box would read as an offline host and would kill any agent still working
in tmux. Always-on bills around the clock; if you only want the browser terminal, turn it off with
`insta compute always-on off <service>`.

## After deploy

1. Open the service URL. An InstaCloud sign-in page asks for the `ADMIN_USERNAME` and
   `ADMIN_PASSWORD` you deployed with. The session lasts 30 days, and changing either variable signs
   every browser out.
2. You land in a `bash` shell in `/data/home`.
3. If you did not set `SUPERSET_API_KEY`, run `superset auth login` and follow the device-code
   prompt, then `superset start --daemon`. If you did, the host is already running: check it with
   `superset status`.
4. In the Superset desktop app, open the **Device** filter in the workspaces list and pick this
   host. Teammates do not see it until you add them under **Settings -> Hosts**.
5. Clone your repositories into `/data/home` (or anywhere under `/data`) so your work persists.
   Files written outside `/data` are lost when the container is replaced.
6. `superset stop` takes the host off the relay and leaves the terminal running.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. The node base image, the ttyd release asset and
  upstream's CLI tarball are all published for both.
- Upstream: <https://github.com/superset-sh/superset>
- CLI and host-service documentation: <https://docs.superset.sh/cli/getting-started>
- Remote access: <https://docs.superset.sh/remote-access>
- ttyd: <https://github.com/tsl0922/ttyd>
- License: Elastic License 2.0 (upstream `superset-sh/superset`).
