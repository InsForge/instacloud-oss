# Twenty

Open-source CRM for contacts, companies and deals.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://console.instacloud.com/templates/twenty)

## Overview

[Twenty](https://github.com/twentyhq/twenty) is a CRM: people, companies, opportunities, notes and
tasks, on customisable record views with a kanban and a table mode, plus workflows, a REST API and
a GraphQL API. Upstream describes it as the open-source alternative to Salesforce.

This template deploys upstream's own release image against a managed PostgreSQL service. It is the
upstream application, not a reimplementation: the image is `twentycrm/twenty:v2.41.0` and its own
entrypoint still creates the schema and runs the migrations.

Upstream's `docker-compose.yml` is four containers. Two of them cannot be expressed in a template
manifest, which declares only `web` and `postgres` services, so this template's image adds them
beside the server: **Redis** (Twenty requires `REDIS_URL` for its cache and its BullMQ queues) and
the **worker** (upstream runs it as a second container off this same image). Both are upstream's
own components, started by a 60-line entrypoint; see [Scope](#scope) for what that costs you.

## What you get by hosting it

- An HTTPS URL for the CRM, with no port forwarding or tunnel to manage.
- A managed PostgreSQL service holding every record, created and wired by the platform. You never
  type a database URL, and the database is backed up and resized by the platform rather than by
  this template.
- The worker running, so Twenty's background jobs actually run: workflow executions, search index
  updates, and the message and calendar sync if you connect an account.
- A persistent volume at `/data` holding uploaded attachments and workspace logos
  (`STORAGE_LOCAL_PATH=/data/storage`) and Redis's append-only file, so a restart keeps both the
  files and the queue.
- `APP_SECRET` and `ENCRYPTION_KEY` generated for you and stored as managed secrets. Twenty signs
  tokens with the first and encrypts stored third-party credentials with the second.
- `SERVER_URL` already resolved to the service's own address, so invite links and email links
  point at the instance rather than at localhost.

## What you need before deploying

- Nothing. The template declares no variables: Twenty runs its own sign-up screen on first visit,
  where you create the first user and the workspace.
- An SMTP server, if you want Twenty to send invitations and password resets. It is configured
  after deploy, not as a deploy variable.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `APP_SECRET` | generated | 64-character key Twenty uses to sign its tokens. You do not set it, and it must stay stable across deploys or every session is invalidated. |
| `ENCRYPTION_KEY` | generated | 64-character key for at-rest encryption of stored secrets, such as connected-account tokens. Must stay stable across deploys or those become unreadable. |
| `PG_DATABASE_URL` | platform | Bound to the managed `db` service's `DATABASE_URL`. Not a value you supply or can edit. |

Set by the template, not by you: `NODE_PORT=3000`, `SERVER_URL` resolved to the service's own HTTPS
URL, `REDIS_URL=redis://127.0.0.1:6379` (the in-container Redis), `STORAGE_TYPE=local`,
`STORAGE_LOCAL_PATH=/data/storage`, and `PG_SSL_ALLOW_SELF_SIGNED=true` for the managed database's
TLS lane.

The service is always-on. Twenty registers cron jobs that fire from inside the process, so an idle
machine would never wake to run them.

**Boot times, measured on this template.** The first deploy takes about 75 seconds from container
start to a healthy `/healthz`, because upstream's entrypoint creates the schema and runs every
migration before the server listens. A restart takes about 17 seconds: the image records the
version setup last ran for on the volume and goes straight to the server when nothing has changed.
While either is happening, a small listener holds port 3000 and answers 503, which is what stops
the deploy's port probe from timing out on the first boot.

## Scope

**Redis and the worker share the web container.** Upstream separates them, and this template does
not, because a manifest cannot declare a managed Redis or a `type: worker` service. The practical
consequences: the three processes share one machine's CPU and memory, a worker crash takes the
whole service down and restarts it (the entrypoint exits non-zero on purpose, so nothing is left
running against a dead worker), and the instance does not scale to more than one worker.

**Redis holds queue state on the volume, not in the managed database.** The append-only file under
`/data/redis` is what survives a restart. It is not backed up by the platform the way the managed
PostgreSQL is; a lost volume loses in-flight jobs and uploaded attachments, not your records.

**Sign-up is open until you close it.** Twenty runs in single-workspace mode
(`IS_MULTIWORKSPACE_ENABLED` is off), and the first person to reach the URL creates the workspace
and becomes its admin. After that, whether anyone else can join is Twenty's own
**Settings > Security** setting, which is on the admin to set.

**It bills continuously.** `alwaysOn: true` is what keeps the cron jobs and the worker running, but
it means the service is never idle-stopped and is charged from deploy until you delete it.

## After deploy

1. Open the service URL **immediately**. Twenty is unauthenticated until someone signs up: **the
   first visitor becomes the workspace admin**. Do not share the URL before you have claimed it.
2. Create the account. This is the admin login: there is no default password to change.
3. In **Settings > Security**, decide whether anyone else may sign up or join by invite link.
4. Add a company and a person, or import a CSV from the record list, and the CRM is in use.
5. A token from **Settings > Playground** gets you the REST API at `/rest/core/...` and the
   GraphQL API at `/graphql` on the same URL.

## Licensing

Twenty is licensed **AGPL-3.0-only**, with a handful of files marked `/* @license Enterprise */`
under separate commercial terms. None of those are enabled by this template. The image this
template builds also carries Alpine's `redis` package, which is AGPL-3.0-only OR SSPL-1.0.

## Links

- Architectures: `linux/amd64` and `linux/arm64`, as published by the upstream image.
- Documentation: <https://twenty.com/developers/section/self-hosting>
- Upstream: <https://github.com/twentyhq/twenty>
- Base image: `docker.io/twentycrm/twenty`, pinned to `v2.41.0`
- License: AGPL-3.0-only (see <https://github.com/twentyhq/twenty/blob/main/LICENSE>).
