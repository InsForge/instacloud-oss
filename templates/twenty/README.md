# Twenty

Open-source CRM for contacts, companies and deals.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://console.instacloud.com/templates/twenty)

## Overview

[Twenty](https://github.com/twentyhq/twenty) is a CRM: people, companies, opportunities, notes and
tasks, on customisable record views with a kanban and a table mode, plus workflows, a REST API and
a GraphQL API. Upstream describes it as the open-source alternative to Salesforce.

This template deploys upstream's own release image against a managed PostgreSQL and a managed Redis.
It is the upstream application, not a reimplementation: the image is `twentycrm/twenty:v2.41.0` and
its own entrypoint still creates the schema and runs the migrations.

Upstream's `docker-compose.yml` is four containers and this template is four services, one for
one: the managed `db` and `cache` datastores, the `crm` web service, and the `jobs` worker. The
worker is the same image as the web service, told which one it is by an environment variable,
because a manifest has no `command:` key and upstream distinguishes the two only by what the
container runs.

The deploy form asks for nothing. The instance comes up on upstream's own welcome page with
sign-up open, and the first person to open the URL creates the account, names the workspace and
becomes its admin, example records and all. Making that account is also what closes sign-up, so
open the URL yourself before you share it.

## What you get by hosting it

- An HTTPS URL for the CRM, with no port forwarding or tunnel to manage.
- Upstream's sign-up flow, untouched: you pick the email, the password and the workspace name in
  the browser, and Twenty fills the new workspace with its example companies, people,
  opportunities and dashboard the way it does everywhere else.
- A managed PostgreSQL service holding every record, created and wired by the platform. You never
  type a database URL, and the database is backed up and resized by the platform rather than by
  this template.
- A managed Redis for the cache and the BullMQ queues. Twenty hardcodes the BullMQ driver and
  `REDIS_URL` has no default, so this is required rather than an optimisation.
- The worker as its own service, so Twenty's background jobs actually run: workflow executions,
  CSV imports, search index updates, and the message and calendar sync if you connect an account.
  It has its own machine, so a long job does not compete with the request the person in front of
  the CRM is waiting on.
- A persistent volume at `/data` on the web service holding uploaded attachments and workspace
  logos (`STORAGE_LOCAL_PATH=/data/storage`), so a restart keeps the files.
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

Set by the template, not by you: `NODE_PORT=3000`, `SERVER_URL` resolved to the web service's own
HTTPS URL, `STORAGE_TYPE=local`, `STORAGE_LOCAL_PATH=/data/storage`,
`PG_SSL_ALLOW_SELF_SIGNED=true` for the managed database's TLS lane,
`NODE_OPTIONS=--require /insta-sni.cjs` for the managed Redis's (see below), and
`INSTA_TWENTY_ROLE`, which is the one thing that differs between the two compute services.

**Why the Redis connection needs a preload.** The managed Redis lane puts many databases behind one
TLS port and picks yours out of the handshake's server name. Twenty builds both of its Redis
clients from `REDIS_URL` alone, with no TLS options and no setting to add any, so neither sends
that name: the connection is opened, silently dropped, and retried forever with nothing logged. The
image ships a nine-line `sni.cjs` that fills the name in on outbound TLS connections that left it
blank, and `NODE_OPTIONS` preloads it. It changes nothing else, and it is the only reason this
template can use a managed Redis at all.

Both compute services are always-on, for different reasons. The worker has no choice: nothing is
routed to a worker, so no request could ever wake it and a sleeping queue consumer is a queue that
never drains. The web service could sleep now that the worker owns the background work, and it does
not because Twenty's cold boot is tens of seconds, which is how long the first request after an
idle stop would wait.

**Boot times, measured on this template.** The first deploy takes about 40 seconds from container
start to a healthy `/healthz`, most of it Twenty creating its schema and running every migration
before the server can listen. A restart is about the same, minus the migrations: the image records
the version setup last ran for on the volume and goes straight to the server when nothing has
changed. While either is happening, a small listener holds port 3000 and answers 503, which is what
stops the deploy's port probe from timing out.

These numbers move with the machine. An earlier build of this template measured 105 seconds on a
slower run, which overran the platform's 90-second health gate and reported one of two services
unhealthy on a deploy that was in fact fine fifteen seconds later. The entrypoint's job is to keep
that distance: on an empty database it runs the migrations and nothing else, and the cron
registration happens only after the server answers, so it does not compete with the boot for the
machine.

## Scope

**Four services, four bills.** The managed PostgreSQL and the managed Redis are each born with
their own volume, and the web service and the worker each mount one of their own. That is the
shape upstream's compose has; it is not a small deployment.

**The two compute services do not share a disk.** Upstream's compose gives the server and the
worker the same `.local-storage` volume; the platform gives each service its own. Uploads are
invisible to this, because the web service both receives and serves them, but a job that writes a
file and expects the server to hand it back would not find it. Setting `STORAGE_TYPE=s3` and the
`STORAGE_S3_*` variables against a bucket gives both services one store and is the right answer
for real use.

**Queue state lives in the managed Redis.** That is what survives a restart of either compute
service, and it is the platform's to size and keep, not this template's.

**There is one account and the first visitor gets it.** Twenty runs in single-workspace mode
(`IS_MULTIWORKSPACE_ENABLED` is off), where its own gate is `isSignUpEnabled = multiworkspace ||
no workspace exists yet`: the moment a workspace exists the sign-up page answers *"New workspace
setup is disabled"*. This template leaves that as upstream ships it, so the URL is a race until
you have signed up. Open it yourself first, and everybody else joins by invitation from
**Settings > Members**.

**It bills continuously.** Both compute services are `alwaysOn: true`, so neither is idle-stopped
and both are charged from deploy until you delete them.

**Self-hosted InstaCloud cannot run this template yet.** It declares a managed `redis` service, and
the runtime in this repository parses only `web`, `worker` and `postgres`, so it skips the template
with a warning. It deploys on the hosted platform.

**The workspace arrives with Twenty's example data in it.** Activating a workspace calls
`prefillCreatedWorkspaceRecords`, which writes five companies (Airbnb, Anthropic, Stripe, Figma,
Notion), five people, six opportunities and a dashboard, plus two pre-installed workflows. That is
upstream's behaviour and v2.41.0 has no setting that turns it off. Select the rows in **Companies**
and **People** and delete them when you want the CRM to yourself; **Workflows** in the sidebar
removes the two automations.

## After deploy

1. Open the service URL. Twenty's welcome page asks for an email and a password: what you type
   there becomes the admin account, so do this before you hand the URL to anyone else. The
   password must be 8 to 50 characters, which is Twenty's own rule.
2. Name the workspace and fill in your own name when Twenty asks. Both are editable later in
   **Settings**.
3. Invite your colleagues from **Settings > Members**. The sign-up page is closed to everyone
   else now that the workspace exists, so an invitation is the way in.
4. Add a company and a person, or import a CSV from the record list, and the CRM is in use. The
   example records Twenty put there are yours to delete.
5. A token from **Settings > Playground** gets you the REST API at `/rest/core/...` and the
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
- Base image: `docker.io/twentycrm/twenty`, pinned to `v2.41.0`
- License: AGPL-3.0-only (see <https://github.com/twentyhq/twenty/blob/main/LICENSE>).
