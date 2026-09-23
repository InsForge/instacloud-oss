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

This template runs the official `gitea/gitea` image. The overlay in `./Dockerfile` adds no
application code. It does two things upstream's image leaves to a human at a terminal: it
translates this manifest's variable names into the `GITEA__<section>__<KEY>` form Gitea reads,
because a platform env name must match `^[A-Z][A-Z0-9_]{0,63}$` and that form is lower-case in
the middle, and it creates the first administrator, because Gitea's install wizard is its only
route to a first account and this template locks that wizard.

## What you get by hosting it

- A private Git host on an HTTPS URL, with your repositories, issues and pull requests on a
  volume you own rather than in someone else's account.
- Clone, fetch and push over HTTPS, authenticating with your Gitea username and password or with
  a personal access token created under *Settings / Applications*.
- Git LFS, enabled, with objects stored beside the repositories on the same volume.
- A persistent volume at `/data`, which is where the upstream image already puts everything:
  repositories under `/data/git/repositories`, the SQLite database at `/data/gitea/gitea.db`, LFS
  objects, avatars, attachments and the issue index. No path is overridden to get there.
- An instance that is closed by default: self-signup is off and every page needs a sign-in, so
  the URL is not a public repository browser until you decide it should be.

## What you need before deploying

- A username and a password for the first administrator. The password must be at least 8
  characters, which is Gitea's `[security] MIN_PASSWORD_LENGTH`.
- Nothing else. There is no external database or object store to provision.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | Username for the first administrator, which is the only account on a fresh deploy. Letters, digits, dash, underscore and dot. |
| `ADMIN_PASSWORD` | yes | Its password, at least 8 characters. Stored write-only, so keep your own copy: nothing can read it back to you. |
| `ADMIN_EMAIL` | no | The administrator's email, used for commit attribution and notifications. Defaults to `admin@example.com`. |
| `APP_NAME` | no | Title in the browser tab and the page header. Defaults to `Gitea`. |
| `DISABLE_REGISTRATION` | no | `true` (the default) keeps the instance closed to self-signup. Set `false` to let anyone with the URL create an account. |
| `REQUIRE_SIGNIN_VIEW` | no | `true` (the default) hides every page behind a sign-in. Set `false` to let anonymous visitors browse and clone public repositories. |
| `SECRET_KEY` | generated | Gitea's `[security] SECRET_KEY`, which encrypts 2FA secrets and mirror credentials at rest. You never need to read it. |

Those last two are here rather than in the app because Gitea's site administration panel shows
its configuration read-only: these are settings you decide at deploy time or edit in `app.ini`
afterwards, not in the UI.

Set by the template, not by you: `ROOT_URL` and `DOMAIN` resolved to the service's own HTTPS
address (Gitea builds every clone URL, webhook payload and OAuth2 redirect from `ROOT_URL`, and
takes the session cookie's `Secure` flag from its scheme), `HTTP_PORT=3000`, `INSTALL_LOCK=true`,
`LFS_START_SERVER=true` and `DISABLE_SSH=true`.

The service is not always-on. Every way into a Git host is an inbound HTTP request that wakes the
machine, `git clone` over HTTPS included. Turn always-on on if you add Gitea Actions runners or
repository mirrors, which are scheduled from inside the process.

## After deploy

1. Open the service URL and sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
2. Create a repository from the **+** menu.
3. Clone it over HTTPS: `git clone https://<your-service-url>/<user>/<repo>.git`. Git will ask for
   your Gitea username and password; a personal access token from *Settings / Applications* works
   in place of the password and is the better choice for anything automated.
4. Add other people from *Site Administration / User Accounts*. Self-signup stays off unless you
   deployed with `DISABLE_REGISTRATION=false`.

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
