# Ubuntu Desktop (LXDE, noVNC)

A full Ubuntu 20.04 graphical desktop, reachable from any browser.

> **Draft.** The template deploys and has been verified end to end. It stays out of the catalog
> while two decisions are pending: the desktop's home directory is not on a persistent volume, so
> nothing survives a restart, and its category (`dev-tools`) does not exist yet in the registry.

## Overview

[docker-ubuntu-vnc-desktop](https://github.com/fcwu/docker-ubuntu-vnc-desktop) packages an Ubuntu
LXDE desktop behind noVNC (an HTML5 VNC client) and nginx, so a browser tab is a full graphical
Linux session with no VNC client, no port forwarding, and no tunnel to install.

This template runs the official upstream image unchanged, on the `focal` tag (Ubuntu 20.04 LTS).

## What you get by hosting it

- An HTTPS URL that opens straight into a real Ubuntu LXDE desktop: a taskbar, a file manager, a
  terminal, and whatever you `apt install` inside it.
- HTTP basic auth in front of nginx, so the desktop is not reachable without a password even before
  noVNC's own login screen.
- A full root shell (via the desktop's own terminal emulator) on a fresh Ubuntu machine, useful for
  anything that wants a disposable graphical Linux box rather than a headless one.

## What you need before deploying

- Nothing external. Three variables, described below, all values you choose yourself.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `USER` | yes | Desktop login username. Also names the HTTP basic-auth realm. |
| `PASSWORD` | yes | Password for `USER` inside the container (desktop login / sudo). |
| `HTTP_PASSWORD` | yes | Password nginx's basic auth asks for before serving anything, including the noVNC login page. |

No variable has a default or is generated for you: this is a root graphical session on the public
internet, and the credential is the only thing standing between the URL and it.

## After deploy

1. Open the service's HTTPS URL.
2. Enter `USER` / `HTTP_PASSWORD` at the browser's basic-auth prompt.
3. The noVNC page loads; click **Connect**. If prompted again, use `PASSWORD`.
4. You're at an LXDE desktop. Open the terminal from the taskbar for a normal Ubuntu shell.

## Open questions

- **No persistence.** Upstream's entrypoint keeps desktop state, installed packages, and files
  under `$HOME` inside the container's own root filesystem, with no environment variable to
  redirect it onto a mounted path. `insta compute restart` (or any redeploy) returns to a clean
  image. Whether that is acceptable for this template, or whether it needs a thin-shell Dockerfile
  that relocates `$HOME` onto `/data`, is a product call.
- **New category.** `dev-tools` does not exist in the current category set (`ai-agent`, `llm`,
  `automation`). Either add it or place this template in one of the existing three.
- **`focal` is amd64-only.** Upstream also publishes `focal-arm64` as a separate tag, untested
  here; declaring both architectures on one tag would be wrong (see AGENTS.md's Architectures
  section), so an arm64 variant would need its own verification pass.

## Links

- Upstream: https://github.com/fcwu/docker-ubuntu-vnc-desktop
- Image: https://hub.docker.com/r/dorowu/ubuntu-desktop-lxde-vnc
- License: Apache-2.0
