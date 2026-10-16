# Ghost

Publishing platform for blogs and paid newsletters.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/ghost)

## Overview

[Ghost](https://github.com/TryGhost/Ghost) is a publishing platform: an editor, a themed website,
an email newsletter and paid memberships, in one application. Upstream describes it as the
professional publishing platform.

This template deploys the official upstream image with a small entrypoint on top. Ghost itself is
untouched: the application, its Ghost-CLI install and upstream's own `docker-entrypoint.sh` all
still run. The overlay does two things the image leaves to a human at a terminal, and nothing else:
it translates environment variable names into the lower-case form Ghost's configuration uses, and
it creates the site owner before anyone else can.

## What you get by hosting it

- An HTTPS URL for the site and for the `/ghost` admin app, with no port forwarding or tunnel.
- A managed MySQL database, which is the database Ghost supports for production and the one the
  official image is built against. Posts, pages, members, tags and settings live there.
- A persistent volume mounted at `/data`, with Ghost's content path pointed at it, so uploaded
  images, installed themes, the members keypair and the routes file survive a restart or a
  redeploy. The database and the volume together are the whole of the site.
- The owner account created at deploy time from the two variables you supply, so the site is
  claimed before the URL exists rather than by whoever opens it first.
- Your publication, your member list and your Stripe connection on infrastructure you control.

## What you need before deploying

- An email address and a password for the site owner. Ghost identifies staff by email, so the
  address is what you sign in with. Ghost's own rule for the password is at least 10 characters,
  and it rejects anything containing `ghost` or `password`.
- SMTP credentials, if you want staff invites, password resets or member sign-in links to be
  delivered. Optional at deploy time and settable afterwards, but nothing about members works
  without it.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_EMAIL` | yes | Email address for the site owner, and what you sign in with at `/ghost`. Ghost has no username field. |
| `ADMIN_PASSWORD` | yes | Password for that account. At least 10 characters, and not containing `ghost` or `password`: those are Ghost's rules, in `server/lib/validate-password.ts`. |
| `ADMIN_NAME` | no | Display name shown on posts the owner writes. Defaults to `Owner`. |
| `SITE_TITLE` | no | Title of the publication. Defaults to `Ghost`. Editable in Settings afterwards. |
| `STAFF_DEVICE_VERIFICATION` | no | `true` makes Ghost email a six-digit code when a staff member signs in from a new device. Off by default, see below. |
| `MAIL_SMTP_HOST` | no | SMTP server for outgoing mail. Empty means Ghost's direct transport, which most networks drop. |
| `MAIL_SMTP_PORT` | no | Port on that server. Defaults to `587`. |
| `MAIL_SMTP_SECURE` | no | `true` for implicit TLS on 465. Defaults to `false`, which is STARTTLS on 587. |
| `MAIL_SMTP_USER` | no | Username for the SMTP server. Empty for a relay that needs no authentication. |
| `MAIL_SMTP_PASSWORD` | no | Password or API key for that username. |
| `MAIL_FROM` | no | Address outgoing mail is sent from, e.g. `Your Site <hello@example.com>`. |

Set by the template, not by you: the site URL, resolved to the service's own HTTPS address;
`paths__contentPath` and `GHOST_CONTENT`, both `/data`; the five MySQL connection fields, bound
from the managed database; `database__client=mysql2`; and `logging__transports=["stdout"]`, so
`insta compute logs` is the one place logs appear rather than a second rotating copy on the volume.

**Device verification is off by default.** Ghost ships it on: a staff member signing in from a new
device is emailed a six-digit code and cannot continue without it. On an instance with no SMTP
configured that code is never delivered, which locks the owner out of the site they just deployed.
Once outgoing mail works, set `STAFF_DEVICE_VERIFICATION=true` and it behaves as upstream intends.

**It bills continuously.** `alwaysOn: true` is what makes a post scheduled for 9am publish at 9am:
Ghost runs those timers inside its own process, and a machine that has been idle-stopped runs no
timers and is only ever woken by an inbound request. The cost is that the service is charged from
deploy until you delete it.

## After deploy

1. Open the service URL. The published site renders on the stock Source theme with no posts in it.
2. Go to `/ghost` and sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`. The account is already
   there: the setup screen has been completed for you, so there is nothing to claim and no window
   in which a stranger could claim it.
3. Write a post. Publishing it puts it on the front page immediately.
4. Configure outgoing mail if you did not at deploy time, in Settings, then invite staff or open
   memberships. Nothing that sends email works until this is done.
5. Uploaded images and any theme you install land under `/data` on the volume; everything else is
   in the managed MySQL. Both survive a restart and a redeploy.

## Scope

This is a single Ghost instance. It does not run Ghost's optional separate job queue, and it
connects no storage adapter, so uploaded images are files on the volume rather than objects in a
bucket.

**Back up both halves.** The managed database holds the posts and the member list; the volume
holds the images and the members keypair. Neither is snapshotted by this template. Ghost's own
export, in Settings, writes the database half to a JSON file and does not include the images.

**Mail is not configured for you.** Ghost's default transport delivers directly to the recipient's
mail server, which almost every network and almost every recipient rejects. Until `MAIL_SMTP_HOST`
is set, staff invites, password resets and member sign-in links are written to the log rather than
delivered.

## Links

- Architectures: `linux/amd64` and `linux/arm64`, as published by the official image.
- Documentation: <https://ghost.org/docs/>
- Upstream: <https://github.com/TryGhost/Ghost>
- Image: `docker.io/library/ghost`, with this template's overlay published as
  `ghcr.io/insforge/insta-oss/templates/ghost`
- License: MIT (see <https://github.com/TryGhost/Ghost/blob/main/LICENSE>).
