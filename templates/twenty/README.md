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
own components, started by a short entrypoint; see [Scope](#scope) for what that costs you.

The entrypoint also creates the first account from the email and password you type at the deploy
prompt, because Twenty allows exactly one on a self-hosted instance and has no environment
variable for it. It does that through Twenty's own sign-up mutation, not by writing rows.

## What you get by hosting it

- An HTTPS URL for the CRM, with no port forwarding or tunnel to manage.
- The admin account already created from the credentials you typed, so the URL is yours from the
  first second rather than the first visitor's.
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

- An email address and a password for the admin account. They are the deploy form's only two
  fields, and they are what you sign in with; the deploy creates that account for you.
- An SMTP server, if you want Twenty to send invitations and password resets. It is configured
  after deploy, not as a deploy variable.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_EMAIL` | yes | The address you sign in with. Twenty authenticates by email and has no usernames. The deploy creates this account and it is the workspace admin. |
| `ADMIN_PASSWORD` | yes | Password for that account. Twenty's own rule is 8 to 50 characters and it refuses anything shorter. Not stored anywhere you can read it back, so keep your copy; a lost password is reset from **Settings**, or by mail if you have configured SMTP. |
| `APP_SECRET` | generated | 64-character key Twenty uses to sign its tokens. You do not set it, and it must stay stable across deploys or every session is invalidated. |
| `ENCRYPTION_KEY` | generated | 64-character key for at-rest encryption of stored secrets, such as connected-account tokens. Must stay stable across deploys or those become unreadable. |
| `PG_DATABASE_URL` | platform | Bound to the managed `db` service's `DATABASE_URL`. Not a value you supply or can edit. |

Set by the template, not by you: `NODE_PORT=3000`, `SERVER_URL` resolved to the service's own HTTPS
URL, `REDIS_URL=redis://127.0.0.1:6379` (the in-container Redis), `STORAGE_TYPE=local`,
`STORAGE_LOCAL_PATH=/data/storage`, and `PG_SSL_ALLOW_SELF_SIGNED=true` for the managed database's
TLS lane.

The service is always-on. Twenty registers cron jobs that fire from inside the process, so an idle
machine would never wake to run them.

**Boot times, measured on this template.** The first deploy takes about 40 seconds from container
start to a healthy `/healthz`, most of it Twenty creating its schema and running every migration
before the server can listen. A restart is about the same, minus the migrations: the image records
the version setup last ran for on the volume and goes straight to the server when nothing has
changed. While either is happening, a small listener holds port 3000 and answers 503, which is what
stops the deploy's port probe from timing out.

These numbers move with the machine. The same image measured 105 seconds on a slower run, which
overran the platform's 90-second health gate and reported one of two services unhealthy on a
deploy that was in fact fine fifteen seconds later. The entrypoint's job is to keep that distance:
on an empty database it runs the migrations and nothing else, and it starts the worker and the
cron registration only after the server answers, so neither competes with it for the machine.

## Scope

**Redis and the worker share the web container.** Upstream separates them, and this template does
not, because a manifest cannot declare a managed Redis or a `type: worker` service. The practical
consequences: the three processes share one machine's CPU and memory, a worker crash takes the
whole service down and restarts it (the entrypoint exits non-zero on purpose, so nothing is left
running against a dead worker), and the instance does not scale to more than one worker.

**Redis holds queue state on the volume, not in the managed database.** The append-only file under
`/data/redis` is what survives a restart. It is not backed up by the platform the way the managed
PostgreSQL is; a lost volume loses in-flight jobs and uploaded attachments, not your records.

**There is one account, and the deploy creates it.** Twenty runs in single-workspace mode
(`IS_MULTIWORKSPACE_ENABLED` is off), where its own gate is `isSignUpEnabled = multiworkspace ||
no workspace exists yet`: the moment a workspace exists the sign-up page answers *"New workspace
setup is disabled"*. Upstream leaves that first slot to whoever loads the URL first; this template
fills it with `ADMIN_EMAIL` and `ADMIN_PASSWORD` a second or two after the server starts, so the
URL is not a race. Everybody else joins by invitation from **Settings > Members**.

**It bills continuously.** `alwaysOn: true` is what keeps the cron jobs and the worker running, but
it means the service is never idle-stopped and is charged from deploy until you delete it.

## After deploy

1. Open the service URL and sign in with the email and password you gave at the deploy prompt.
2. Finish Twenty's onboarding: name the workspace, then your own name. Two screens, once.
3. Invite your colleagues from **Settings > Members**. The sign-up page is closed to everyone
   else now that the workspace exists, so an invitation is the way in.
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
