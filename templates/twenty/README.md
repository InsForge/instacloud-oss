# Twenty

Open-source CRM for contacts, companies and deals.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/twenty)

## Overview

[Twenty](https://github.com/twentyhq/twenty) is a CRM: people, companies, opportunities, notes and
tasks, on customisable record views with a kanban and a table mode, plus workflows, a REST API and
a GraphQL API. Upstream describes it as the open-source alternative to Salesforce.

This template deploys upstream's own release image, `twentycrm/twenty:v2.44.0`, against a managed
PostgreSQL and a managed Redis. Nothing of Twenty is rebuilt. Setup is upstream's own
`database:init:prod`, `upgrade`, `cache:flush` and `cron:register:all`, run in upstream's order on
every boot.

Upstream's `docker-compose.yml` is four containers: PostgreSQL, Redis, the server and the worker.
The platform supplies the first two as the managed `db` and `cache` services. The server and the
worker run together in the `crm` service, because with local file storage they have to share a
disk. Upstream's compose mounts one volume into both containers for the same reason.

The deploy form asks for nothing. The instance comes up on upstream's own welcome page with
sign-up open, and the first person to open the URL creates the account, names the workspace and
becomes its admin. Making that account is also what closes sign-up, so open the URL yourself before
you share it.

## What you get by hosting it

- An HTTPS URL for the CRM, with no port forwarding or tunnel to manage.
- Upstream's sign-up flow, untouched: you pick the email, the password and the workspace name in
  the browser.
- A managed PostgreSQL service holding every record, created and wired by the platform. You never
  type a database URL, and the database is backed up and resized by the platform rather than by
  this template.
- A managed Redis for the cache and the BullMQ queues. Twenty hardcodes the BullMQ driver and
  `REDIS_URL` has no default, so this is required rather than an optimisation.
- Twenty's queue worker running beside the server, so background work actually happens: workflow
  runs, including their code steps, scheduled triggers, search index updates, and the message and
  calendar sync if you connect an account. It starts once the server passes its health check, and
  restarts on its own if it exits.
- A persistent volume at `/data` holding uploaded attachments, workspace logos and the source of
  workflow code steps (`STORAGE_LOCAL_PATH=/data/storage`), so a restart keeps the files.
- `APP_SECRET` and `ENCRYPTION_KEY` generated for you and stored as managed secrets. Twenty signs
  tokens with the first and encrypts stored third-party credentials with the second.
- `SERVER_URL` already resolved to the service's own address, so invite links and email links
  point at the instance rather than at localhost.

## What you need before deploying

- Nothing. The deploy form has no fields: everything Twenty needs is either generated for you or
  bound to the managed services.
- Be ready to open the URL as soon as the deploy finishes, since the first visitor is the one who
  gets the admin account.
- An SMTP server, if you want Twenty to send invitations and password resets. It is configured
  after deploy, not as a deploy variable.

## Configuration

**There is nothing to fill in.** The template declares no required and no optional variables, so
the deploy prompt is empty and you configure the CRM in its own settings afterwards. The four
below are supplied for you and are listed so you know what they are, not so you can set them.

| Variable | Required | What it does |
|---|---|---|
| `APP_SECRET` | generated | 64-character key Twenty uses to sign its tokens. You do not set it, and it must stay stable across deploys or every session is invalidated. |
| `ENCRYPTION_KEY` | generated | 64-character key for at-rest encryption of stored secrets, such as connected-account tokens. Must stay stable across deploys or those become unreadable. |
| `PG_DATABASE_URL` | platform | Bound to the managed `db` service's `DATABASE_URL`. Not a value you supply or can edit. |
| `REDIS_URL` | platform | Bound to the managed `cache` service. Same: supplied by the platform. |

Set by the template, not by you: `NODE_PORT=3000`, `SERVER_URL` resolved to the service's own
HTTPS URL, `STORAGE_TYPE=local`, `STORAGE_LOCAL_PATH=/data/storage`,
`PG_SSL_ALLOW_SELF_SIGNED=true` for the managed database's TLS lane, and
`NODE_OPTIONS=--require /insta-sni.cjs` for the managed Redis's (see below).

**Why the Redis connection needs a preload.** The managed Redis lane puts many databases behind one
TLS port and picks yours out of the handshake's server name. Twenty builds both of its Redis
clients from `REDIS_URL` alone, with no TLS options and no setting to add any, so neither sends
that name: the connection is opened, silently dropped, and retried forever with nothing logged. The
image ships a short `sni.cjs` that fills the name in on outbound TLS connections that left it
blank, and `NODE_OPTIONS` preloads it. It changes nothing else.

**Boot order.** Every boot runs upstream's setup before the server starts: the migrations on an
empty database, otherwise the upgrade and the two cache flushes, which do nothing when the schema
is already current. A failed upgrade step is logged and retried on the next boot, the way
upstream's own entrypoint treats it. While setup runs, a small listener holds port 3000 and
answers 503, which is what stops the deploy's port probe from timing out. Once the server answers
its health check, the queue worker starts and the cron jobs are registered.

## Scope

**Three services, three volumes.** The managed PostgreSQL and the managed Redis are each born with
their own volume, and `crm` mounts a third. It is not a small deployment.

**It bills continuously.** `crm` is `alwaysOn: true` because the queue worker lives in it: a
machine that slept would run no scheduled workflow and no sync until somebody opened the CRM.

**Files live on the `crm` volume.** That is the right default for one machine. For more than one,
or to keep files independent of the machine, set `STORAGE_TYPE=s3` and the `STORAGE_S3_*`
variables against a bucket.

**There is one account and the first visitor gets it.** Twenty runs in single-workspace mode
(`IS_MULTIWORKSPACE_ENABLED` is off), where sign-up is open only while no workspace exists. This
template leaves that as upstream ships it, so the URL is a race until you have signed up. Open it
yourself first, and everybody else joins by invitation from **Settings > Members**.

**Self-hosted InstaCloud cannot run this template yet.** It declares a managed `redis` service, and
the template parser in this repository's runtime reads only `web`, `worker` and `postgres`, so it
skips the template with a warning. It deploys on the hosted platform.

**The workspace arrives with Twenty's example data in it.** Activating a workspace fills it with
example companies, people and opportunities, plus pre-installed workflows. That is upstream's
behaviour and there is no setting that turns it off. Select the rows and delete them when you want
the CRM to yourself.

## After deploy

1. Open the service URL. Twenty's welcome page asks for an email and a password: what you type
   there becomes the admin account, so do this before you hand the URL to anyone else.
2. Name the workspace and fill in your own name when Twenty asks. Both are editable later in
   **Settings**.
3. Invite your colleagues from **Settings > Members**. The sign-up page is closed to everyone
   else now that the workspace exists, so an invitation is the way in.
4. Add a company and a person, or import a CSV from the record list, and the CRM is in use. The
   example records Twenty put there are yours to delete.
5. A token from **Settings > APIs & Webhooks** gets you the REST API at `/rest/...` and the
   GraphQL API at `/graphql` on the same URL.

## Licensing

Twenty is licensed **AGPL-3.0-only**, with a handful of files marked `/* @license Enterprise */`
under separate commercial terms. None of those are enabled by this template. The image this
template builds adds shell and node scripts to upstream's release image and no third-party
software.

## Links

- Architectures: `linux/amd64` and `linux/arm64`, as published by the upstream image.
- Documentation: <https://twenty.com/developers/section/self-hosting>
- Upstream: <https://github.com/twentyhq/twenty>
- Base image: `docker.io/twentycrm/twenty`, pinned to `v2.44.0`
- License: AGPL-3.0-only (see <https://github.com/twentyhq/twenty/blob/main/LICENSE>).
