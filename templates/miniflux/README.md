# Miniflux

Minimalist feed reader with a REST API.

**This template is a draft.** The registry's category set is `ai-agent`, `llm` and `automation`,
and a feed reader is none of the three. `automation` is the nearest fit, because the part of
Miniflux that runs unattended is its feed scheduler, but picking or adding a category is a
maintainer's call, so this stays out of the gallery until one is made.

## Overview

[Miniflux](https://github.com/miniflux/v2) is a self-hosted RSS, Atom, RDF and JSON feed reader
written in Go. It has no JavaScript framework, no tracking and no account service behind it: a
single binary talks to a Postgres database and serves HTML, plus a REST API and the Fever and
Google Reader APIs for third-party clients.

This template runs upstream's official image unmodified. It is the reader itself, not a wrapper:
there is no overlay Dockerfile here, and no code in this repository is between you and the app.

## What you get by hosting it

- Your reading list and read state in a database you own, instead of in a vendor's account.
- A REST API and Fever and Google Reader endpoints, so mobile clients (Reeder, NetNewsWire,
  FocusReader) read the same account.
- Built-in article scraping, filtering rules and full-text search over what you have fetched.
- Automatic refreshes on a schedule the service runs itself, with no external cron.

## What you need before deploying

- A username and password for the first account (`ADMIN_USERNAME` and `ADMIN_PASSWORD`).
  Miniflux refuses a password shorter than 6 characters.
- Nothing else. Feeds are added in the app after it starts.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `ADMIN_USERNAME` | yes | Username for the first Miniflux account, created on first boot. |
| `ADMIN_PASSWORD` | yes | Password for that account. Miniflux rejects anything shorter than 6 characters. It is not generated here on purpose: a template variable is stored write-only, so a generated password could never be read back. |
| `POLLING_FREQUENCY` | no | Minutes between automatic feed refreshes. Upstream's default is 60. Server-wide, with no equivalent in the app's UI. |
| `CLEANUP_ARCHIVE_READ_DAYS` | no | Days a read entry is kept before it is archived. Upstream's default is 60, and `-1` keeps everything. |

The template also declares a `postgres` service. Its `DATABASE_URL` is bound into the web service
by the platform; there is nothing to configure.

Fixed by the template: `RUN_MIGRATIONS=1` (Miniflux owns its schema and migrates on boot),
`CREATE_ADMIN=1` (seeds the first account, and is a no-op on every later boot), `HTTPS=1` (TLS is
terminated at the edge, so saying so is what marks the session cookie `Secure`), `BASE_URL` (the
service's own URL, used for the absolute links the app generates) and `LISTEN_ADDR`.

The service listens on port 8080 and is health-checked on `/healthcheck`, which is the app's own
readiness probe: 200 once it can reach the database, 503 while it cannot. `/` is not used for this.
It renders the login page and answers 200 whether or not the database is reachable, so it would
report healthy on a deploy that cannot serve a single feed.

It is declared `alwaysOn: true`. The feed scheduler fires from inside the process, so a machine
that had scaled to zero would never wake to refresh a feed. That bills continuously.

## After deploy

1. Open the service URL and sign in with the `ADMIN_USERNAME` and `ADMIN_PASSWORD` you set.
2. **Add a feed** from the top navigation and paste a site or feed URL. Miniflux discovers the
   feed document from a page URL.
3. **Unread** lists what it fetched. Feeds refresh on the schedule; "Refresh all feeds" on the
   Feeds page forces a pass now.
4. To read from a phone, go to **Settings → API Keys**, create a key, and point a client at the
   service URL with your username and that key.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. Upstream's `2.3.3` index carries both (and
  arm/v6, arm/v7 and riscv64 besides); nothing is rebuilt here.
- Upstream: <https://github.com/miniflux/v2>
- Documentation: <https://miniflux.app/docs/>
- Image: `docker.io/miniflux/miniflux`, pinned to `2.3.3`
- License: Apache-2.0 (upstream `miniflux/v2`).
