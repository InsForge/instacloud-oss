# n8n

Visual workflow automation with 400+ integrations.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/n8n)

## Overview

[n8n](https://github.com/n8n-io/n8n) is a workflow automation tool: you build flows on a canvas,
connecting apps and APIs, and drop into code only where you need it. Upstream describes it as
fair-code workflow automation with native AI capabilities and 400+ integrations.

This template deploys the official upstream image unchanged, as a single n8n instance that keeps
its data in SQLite on a persistent volume. SQLite is n8n's own default, so this is the same
database a local `npm install n8n` would use, and it asks you for nothing at deploy time.

## What you get by hosting it

- An HTTPS URL for the n8n editor, with no port forwarding or tunnel to manage.
- A persistent volume mounted at `/data`, with `N8N_USER_FOLDER` pointed at it, so the SQLite database
  lives on the volume and survives restarts and redeploys along with your settings file and any
  community nodes you install. This pairing is the whole persistence story: without it, a redeploy
  would take your workflows with it.
- The encryption key generated for you and stored as a managed secret. n8n uses it to encrypt
  stored credentials, so it must not change between deploys.
- Webhook and editor URLs already resolved to the service's own address, so the links n8n hands
  out are the ones that work.
- Your workflows and credentials on infrastructure you control, rather than a hosted tier.

## What you need before deploying

- Nothing. The template declares no variables, and n8n runs its own owner-setup wizard on first
  visit, where you create the admin account.
- Credentials for whichever third-party services your workflows will use: added inside n8n, not
  as deploy variables.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `N8N_ENCRYPTION_KEY` | generated | 32-character key n8n uses to encrypt stored credentials. You do not set it, and it must stay stable across deploys. |

Set by the template, not by you: `N8N_USER_FOLDER=/data` (database and settings on the volume),
`N8N_PORT=5678`, `N8N_LISTEN_ADDRESS=0.0.0.0`, `N8N_PROXY_HOPS=1`, and `N8N_WEBHOOK_URL` /
`N8N_EDITOR_BASE_URL` resolved to the service's own HTTPS URL.

The template no longer pins a compute size, so a new service starts at whatever your plan gives
one, and you can change it afterwards from the service settings. The number that mattered when it
did pin one still holds as a floor: n8n sits at roughly 557 MB resident while idle, so anything
around 512 MB leaves no room for a workflow run. The service is always-on, because schedule
and polling triggers fire from inside the process and an idle machine is only ever woken by an
inbound request.

## Scope

This is a single n8n instance, which is what n8n's own default configuration is. It does not run
queue mode, and it does not scale to more than one worker. n8n also supports PostgreSQL, which
this template does not use: n8n reads its database as five separate `DB_POSTGRESDB_*` variables
and no connection string, so a managed database cannot be wired to it from a manifest today.

**The volume is the only copy.** Workflows, encrypted credentials and execution history all live on
that one volume, and nothing here snapshots or replicates it. Export anything you would mind
losing — n8n's own **Download** on a workflow, or the whole set from the workflow list — and keep a
copy of `N8N_ENCRYPTION_KEY`, since exported credentials are unreadable without it.

**It bills continuously.** `alwaysOn: true` is what keeps schedule triggers and webhooks working,
since a stopped machine runs neither, but it means the service is never idle-stopped and is charged
from deploy until you delete it.

## After deploy

1. Open the service URL **immediately**. n8n shows its owner-setup screen on first visit, and it is
   unauthenticated until someone completes it: **the first visitor becomes the owner**, of an
   instance that can run arbitrary code and will hold your third-party credentials. Do not share
   the URL before you have claimed it.
2. Create the owner account. This is the admin login for the instance: there is no default
   password to change.
3. Build a workflow, or import one from n8n's template library.
4. Everything n8n stores lives under `/data` on the volume, so it is still there after a redeploy.

## Licensing

n8n is **fair-code**, not OSS: it is distributed under the Sustainable Use License, and files
marked `.ee` are under a separate enterprise license. This template references the official image
and does not rebuild or rebrand it, which is the condition this registry holds itself to for
fair-code upstreams. Read the upstream license before using it commercially.

## Links

- Architectures: `linux/amd64` and `linux/arm64`, as published by the official image.
- Documentation: <https://docs.n8n.io>
- Upstream: <https://github.com/n8n-io/n8n>
- Image: `docker.io/n8nio/n8n`, pinned to `2.36.5`
- License: Sustainable Use License (see <https://github.com/n8n-io/n8n/blob/master/LICENSE.md>).
