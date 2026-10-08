# Apache Superset

Dashboards and SQL exploration, wired to a managed Postgres.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/superset)

**The service URL is a Superset login on the public internet, and the password you set at deploy
is the only thing guarding it.** Everything you connect Superset to afterwards sits behind that
one account: Superset stores each database's credentials encrypted in its own metadata database
and hands query results to anyone who is signed in. Pick a strong password.

## Overview

[Apache Superset](https://github.com/apache/superset) is a data exploration and visualisation
platform: you write SQL in its SQL Lab editor or build charts in its no-code explorer, and
assemble the results into dashboards.

This template deploys it wired to a managed Postgres. The deploy brings up an InstaCloud Postgres
service alongside Superset and connects the two, and the image carries the Postgres driver, so a
managed database on this platform is one Superset can read as it stands: the one this deploy
creates, or the one behind an app in another of your projects. The platform's managed database is
Postgres, so that is the ordinary path here rather than a special case.

Superset itself ships no warehouse and stores no analytical data. The Postgres this template
creates is Superset's **metadata** database, holding the dashboards, charts, datasets, saved
queries and users you build in it; the data you analyse stays in whichever database you connect.

The image is upstream's official `docker.io/apache/superset`. The overlay built on top of it
adds five files and one pinned Python package, rewrites one line of an upstream shell script, and
changes nothing about Superset itself:

- an **entrypoint** that does what upstream's separate `superset-init` container does in
  docker-compose and the plain image does nowhere: apply the Alembic migrations, sync the role
  and permission definitions, and create the Admin account from `ADMIN_USERNAME` /
  `ADMIN_PASSWORD`. Without it the image starts gunicorn against an empty database and every page
  is a 500.
- a **boot listener** that holds port 8088 with a `503` from the first second, because a first
  boot spends minutes on the migrations and the deploy's connect probe gives it about thirty
  seconds. It is replaced by gunicorn, not proxied through.
- a **`superset_config.py`** that points the metadata database at the managed Postgres service
  and turns on `ENABLE_PROXY_FIX`. Release 6.0.0 has no environment variable for either: the
  `SUPERSET__SQLALCHEMY_DATABASE_URI` override exists on Superset's master branch but is not in
  this release.
- **`psycopg2-binary==2.9.6`**, upstream's own pin for this release. It is the driver both the
  metadata database and every Postgres you later connect go through. `apache/superset:6.0.0` is
  upstream's **lean** image and ships no database driver of its own.
- `run-server.sh` 6.0.0 launches gunicorn without `exec`, so a `SIGTERM` to PID 1 never reached
  it. The image rewrites that one line so a stop drains instead of being killed on the grace
  timer.

## What you get by hosting it

- A managed Postgres service, wired up as Superset's metadata database so every dashboard, chart,
  dataset, saved query and user lands in it. Upstream documents its SQLite default as unsuitable
  for anything but a local trial, and this template never uses it.
- The Postgres driver in the image, so any Postgres you can reach, this deploy's own included, is
  a database you can query from SQL Lab without rebuilding anything.
- An HTTPS URL for Superset, with an Admin account created at deploy time and no setup wizard.
- A persistent volume at `/data` for the pieces Superset keeps on disk: the SQLite file behind
  `SQLALCHEMY_EXAMPLES_URI` and anything uploaded through the CSV, Excel and columnar importers.
- Deploys are health-gated on `/health`, the same path upstream's own `HEALTHCHECK` uses.
- The machine idle-stops and wakes on the next request. Nothing is lost by stopping it: Celery is
  not configured, so there are no scheduled reports, no alerts and no async queries waiting to
  run, and every unit of work starts with an inbound request. The wake re-runs the entrypoint,
  which finds the schema already at its target revision and skips the role sync.

## What you need before deploying

- A username and a password of your choosing. There is no default and nothing is generated: the
  deploy form starts with both fields empty and will not submit until you fill them. A password
  the platform minted would be one it could never show you again, because a template variable is
  stored write-only.
- Nothing else. A database to analyse is something you connect from inside Superset after deploy,
  and it has to be reachable from the internet for Superset to read it. A managed Postgres is,
  and needs nothing installed.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | Username of the Superset Admin account the entrypoint creates on first boot. You choose it. |
| `ADMIN_PASSWORD` | yes | Password for that account. You choose it. It is the only gate in front of the URL. Changing it after deploy does not move the account's password: the entrypoint creates the account if it is missing and never updates one that exists. Change it in Settings, List Users instead. |
| `ADMIN_EMAIL` | no | Email recorded on that account. Cosmetic until you configure SMTP. Defaults to `admin@example.com`. |

Set by the template, not by you: `SUPERSET_HOME=/data` so the volume is Superset's data
directory, `SUPERSET_PORT=8088`, `SUPERSET_ENV=production` (which turns on Flask-Limiter's rate
limits), `SUPERSET_SECRET_KEY` from a generated 64-byte secret, and `DATABASE_URL` bound from the
managed Postgres service. The secret key is generated rather than asked for because Superset
encrypts the stored credentials of every database you connect with it: it has to stay stable, and
nobody ever needs to read it.

## After deploy

1. The first boot runs the Alembic migrations before Superset answers anything, and that takes
   minutes rather than seconds. Until it finishes the URL answers `503 superset is still
   starting`. The deploy's own log tail shows each step with a timestamp.
2. Open the service URL and sign in with the `ADMIN_USERNAME` and `ADMIN_PASSWORD` you deployed
   with.
3. Connect a database: **Settings** (top right), **Database Connections**, **+ Database**,
   **PostgreSQL**. Fill in the host, port, database, user and password of any Postgres you can
   reach, the one this deploy creates included, and it connects with nothing added to the image.
   `insta postgres url <service>` prints those five for a managed one. It has to be reachable
   from the internet. Another engine (MySQL, BigQuery, Snowflake, Trino) needs its driver added
   to the image first, which is an edit to this template's Dockerfile: upstream's lean image
   ships none, and this one carries Postgres.
4. Query it in **SQL Lab**, save the result as a dataset, and chart the dataset from
   **Charts**, **+ Chart**.
5. Assemble charts into a dashboard from **Dashboards**, **+ Dashboard**.

Not configured, and each one needs services this template does not declare:

- **Celery**: no scheduled reports, no alerts, no async query execution and no thumbnail cache.
  All of it needs a Redis broker and a second always-on worker process.
- **Email and Slack**: no SMTP host and no Slack token, so report delivery has nowhere to go.
- **Example data**: `SUPERSET_LOAD_EXAMPLES` is not set. Loading the examples pulls their source
  data over the network on first boot and would put minutes on the clock for every deploy that
  does not want them.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. Upstream's `6.0.0` index carries both, and this
  image only copies in five files, installs a wheel that has a manylinux build for each, and
  rewrites one line of a shell script.
- Documentation: <https://superset.apache.org/docs/intro>
- Configuring Superset: <https://superset.apache.org/docs/configuration/configuring-superset>
- Upstream: <https://github.com/apache/superset>
- Image: `docker.io/apache/superset`, pinned to `6.0.0`
- License: Apache-2.0 (upstream `apache/superset`).
