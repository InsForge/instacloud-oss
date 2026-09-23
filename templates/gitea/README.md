# Gitea

Self-hosted Git service with issues, pull requests and CI

> **Draft.** The template deploys and has been verified end to end; it stays out of the catalog
> while two decisions are pending. `meta.category` is `automation` because the closed set is
> `ai-agent`, `llm` and `automation` and none of them is developer tooling, and cloning over SSH
> is not offered at all, because a compute service has one routed port and it carries HTTP.

## Overview

[Gitea](https://github.com/go-gitea/gitea) is a community-managed, lightweight code hosting
service written in Go: repositories, issues, pull requests, releases, a package registry, and
Gitea Actions for CI. It is the software behind [gitea.com](https://gitea.com), and it runs
comfortably on a single small machine.

It deploys as two services: `gitea`, the official `gitea/gitea` image, and `db`, a managed
postgres the platform owns. The overlay in `./Dockerfile` adds no application code. It does three
things upstream's image leaves to a human at a terminal: it translates this manifest's variable
names into the `GITEA__<section>__<KEY>` form Gitea reads, because a platform env name must match
`^[A-Z][A-Z0-9_]{0,63}$` and that form is lower-case in the middle; it splits the platform's
`DATABASE_URL` into the five separate keys Gitea's `[database]` section reads, because Gitea has
no field that takes a DSN; and it creates the first administrator, because Gitea's install wizard
is its only route to a first account and this template locks that wizard.

## What you get by hosting it

- A private Git host on an HTTPS URL, with your repositories, issues and pull requests in your
  own project rather than in someone else's account.
- A managed postgres holding the relational half: users, issues, pull requests, permissions. The
  platform provisions it, sizes it, backs its volume and mints its credentials.
- Clone, fetch and push over HTTPS, authenticating with your Gitea username and password or with
  a personal access token created under *Settings / Applications*.
- Git LFS, enabled, with objects stored beside the repositories on the same volume.
- A persistent volume at `/data` for everything that is a file rather than a row, which the
  upstream image already puts there: git repositories under `/data/git/repositories`, LFS
  objects, avatars, attachments, packages and the bleve issue index. No path is overridden to
  get there. Both halves have to survive together: a restored volume and an unrelated database
  is not a working Gitea.
- An instance that is closed by default: self-signup is off and every page needs a sign-in, so
  the URL is not a public repository browser until you decide it should be.

## What you need before deploying

- A username and a password for the first administrator. The password must be at least 8
  characters, which is Gitea's `[security] MIN_PASSWORD_LENGTH`.
- Nothing else. The database is the managed `db` service this template declares, so there is
  no connection string to find and nothing external to provision. Note that it is a second
  service with its own volume, so this template costs two.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | Username for the first administrator, which is the only account on a fresh deploy. Letters, digits, dash, underscore and dot. |
| `ADMIN_PASSWORD` | yes | Its password, at least 8 characters. Stored write-only, so keep your own copy: nothing can read it back to you. |
| `ADMIN_EMAIL` | no | The administrator's email, used for commit attribution and notifications. Defaults to `admin@example.com`. |
| `APP_NAME` | no | Title in the browser tab and the page header. Defaults to `Gitea`. |
| `DISABLE_REGISTRATION` | no | `true` (the default) keeps the instance closed to self-signup. Set `false` to let anyone with the URL create an account. |
| `REQUIRE_SIGNIN_VIEW` | no | `true` (the default) hides every page behind a sign-in. Set `false` to let anonymous visitors browse and clone public repositories. |
| `DB_SSL_MODE` | no | Postgres TLS mode: `disable`, `require`, `verify-ca` or `verify-full`. Leave blank and the template uses the `sslmode` in the platform's own `DATABASE_URL`, which is the right answer unless that lane changes under you. |
| `SECRET_KEY` | generated | Gitea's `[security] SECRET_KEY`, which encrypts 2FA secrets and mirror credentials at rest. You never need to read it. |
| `DATABASE_URL` | platform | Bound from the `db` service as `${{services.db.DATABASE_URL}}`. The platform mints it, the entrypoint splits it into `HOST`, `NAME`, `USER`, `PASSWD` and `SSL_MODE`, and you never type it. |

The four `no` rows above are here rather than in the app because Gitea's site administration
panel shows its configuration read-only: they are settings you decide at deploy time or edit in
`app.ini` afterwards, not in the UI.

Set by the template, not by you: `ROOT_URL` and `DOMAIN` resolved to the service's own HTTPS
address (Gitea builds every clone URL, webhook payload and OAuth2 redirect from `ROOT_URL`, and
takes the session cookie's `Secure` flag from its scheme), `HTTP_PORT=3000`, `INSTALL_LOCK=true`,
`LFS_START_SERVER=true`, `DISABLE_SSH=true` and `DB_TYPE=postgres`.

The web service is not always-on. Every way into a Git host is an inbound HTTP request that wakes
the machine, `git clone` over HTTPS included. Turn always-on on if you add Gitea Actions runners
or repository mirrors, which are scheduled from inside the process. The managed `db` service
follows the platform's own policy for a postgres, which this template does not set.

## After deploy

1. Open the service URL and sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
2. Create a repository from the **+** menu.
3. Clone it over HTTPS: `git clone https://<your-service-url>/<user>/<repo>.git`. Git will ask for
   your Gitea username and password; a personal access token from *Settings / Applications* works
   in place of the password and is the better choice for anything automated.
4. Add other people from *Site Administration / User Accounts*. Self-signup stays off unless you
   deployed with `DISABLE_REGISTRATION=false`.

Backing up means backing up both halves at the same point in time. The `/data` volume holds the
git objects and the database holds everything about them, so either one restored on its own
gives you repositories with no issues or issues pointing at repositories that are not there.

There is no SSH remote. A compute service has exactly one routed port and it carries HTTP, so the
image's sshd could never be reached; the overlay removes it and Gitea's UI is told not to offer
the SSH clone URL.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. Upstream's `1.27.3` index carries both (and
  riscv64), and this image only copies a script in.
- Upstream: <https://github.com/go-gitea/gitea>
- Image: `docker.io/gitea/gitea`, pinned to `1.27.3` by index digest via `./Dockerfile`
- Documentation: <https://docs.gitea.com>
- License: MIT (upstream `go-gitea/gitea`).
