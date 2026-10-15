# Uptime Kuma

Self-hosted uptime monitoring with status pages and alerts.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/uptime-kuma)

## Overview

[Uptime Kuma](https://github.com/louislam/uptime-kuma) watches things that are supposed to be up
and tells you when they are not. You add a monitor (an HTTP endpoint, a TCP port, a JSON field in
a response, a push heartbeat from your own cron job), pick how often to check it,
and it draws the result as a bar of heartbeats with a retention history behind it. When a check
fails it fires a notification through one of the hundred-plus channels it ships with, and it can publish
any subset of monitors as a public status page on its own URL.

This template deploys the official upstream image unchanged, as a single instance that keeps
everything in SQLite on a persistent volume. It asks you for nothing at deploy time: Uptime Kuma
creates its own admin account from its setup screen on first visit.

## What you get by hosting it

- An HTTPS URL for the dashboard and for any status pages you publish, with no port forwarding
  or tunnel to manage.
- A persistent volume mounted at `/data`, with `DATA_DIR` pointed at it, so the SQLite database
  lives on the volume. Monitors, heartbeat history, notification channels, status pages, uploaded
  icons and the 2FA secrets are all in that one file, and it survives restarts and redeploys.
- An always-on service, which for this app is the point rather than a cost decision: every monitor
  is a timer inside the process, and a machine idle-stopped between checks would report uptime it
  never measured.
- Monitoring that runs somewhere other than the thing it monitors, which is the property a status
  page needs and a check running on your own box does not have.

## What you need before deploying

- Nothing. The template declares no required variables.
- Somewhere for alerts to go, if you want them: an SMTP server, or a Slack / Discord / Telegram /
  PagerDuty / Gotify / ntfy endpoint. Notification channels are configured inside the app after
  deploy, not as deploy variables.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `UPTIME_KUMA_WS_ORIGIN_CHECK` | optional | Left unset, Uptime Kuma refuses a websocket upgrade whose `Origin` does not match the `Host` it was given, which some reverse proxies rewrite. `bypass` turns that check off. On this platform the dashboard runs on socket.io long-polling and works fully, and the check was never observed refusing anything, so this is for your own proxy rather than for that. |
| `UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN` | optional | Set to `1` to drop the `X-Frame-Options: sameorigin` header, so a status page can be embedded in an iframe on another site. |
| `TZ` | optional | IANA timezone for timestamps in the UI and in notifications, such as `Europe/Berlin`. Defaults to UTC, and **Settings > Appearance** overrides it after deploy. |

Set by the template, not by you: `DATA_DIR=/data` (the SQLite database on the volume),
`UPTIME_KUMA_DB_TYPE=sqlite` (skips the database wizard, which would otherwise be the first screen
and would offer an external MariaDB this template does not ship), and `UPTIME_KUMA_PORT=3001` /
`UPTIME_KUMA_HOST=0.0.0.0` (the port the process binds pinned to the port the platform routes).

There is no `ADMIN_PASSWORD` here, and that is upstream's shape rather than an omission. Uptime
Kuma has no bootstrap environment variables: the only code path that writes the first user is its
own setup screen, so a password given at deploy time would be a value nothing reads. See
**After deploy**, which is where that matters.

## Scope

This is a single instance on SQLite, which is Uptime Kuma's own default. Upstream's 2.x setup
wizard also offers an external MariaDB; this template answers that question for you and does not
expose the `UPTIME_KUMA_DB_*` variables that would point at one. It does not run in a cluster, and
two instances cannot share one volume.

**The volume is the only copy.** Monitors, history, notification channels and status pages are all
in that one SQLite file, and nothing here snapshots or replicates it. Uptime Kuma's
**Settings > Backup** exports monitors and notifications as JSON; heartbeat history is not included
in that export.

**It bills continuously.** `alwaysOn: true` is what keeps the checks running. A scaled-to-zero
machine would run no monitors at all and then show an unbroken green bar for the window it was
asleep, which is worse than not monitoring.

**It is not an APM.** Uptime Kuma answers "is it responding", not "why is it slow". It stores a
response time per check and nothing from inside your application.

**Three of the monitor types do not work here**, because of what the container can reach rather
than anything in this template. Measured from inside the deployed service:

| Type | Why |
|---|---|
| Ping | ICMP gets no replies out of the container. `ping -c 2 example.com` and `ping -c 2 1.1.1.1` both come back 100% packet loss. |
| DNS | Only the platform's own resolver answers. A query to `1.1.1.1` times out, and that is the address Uptime Kuma fills the resolver field with by default. |
| Docker Container | There is no Docker socket in the container and the platform exposes no Docker API, so there is no daemon to inspect. A remote Docker host you run yourself and expose over TCP would work. |

Outbound TCP is otherwise unrestricted, including ports other than 80 and 443: connections to
`example.com:80`, `example.com:443`, `github.com:22` and `smtp.gmail.com:587` all succeed, so the
HTTP(s), TCP Port, SMTP and database monitor types have a route to work over. Only the HTTP(s) one
has actually been run.

## After deploy

1. Open the service URL **immediately**. Uptime Kuma shows its setup screen on first visit and is
   unauthenticated until someone completes it: **the first visitor becomes the administrator**.
   Do not share the URL before you have claimed it.
2. Create the admin account. There is no default password to change, and the app rejects a password
   its own strength check calls too weak, so `123456` and the like will not be accepted.
3. Add a monitor: **+ Add New Monitor**, pick a type, give it a URL and an interval, and save. The
   heartbeat bar starts filling on the next check.
4. Add a notification channel in **Settings > Notifications**, then attach it to the monitor, or it
   will watch silently.
5. Publish a **Status Page** if you want a public view: it gets its own slug under the same URL,
   and it is the only part of the instance visible without signing in.
6. Everything lives under `/data` on the volume, so it is still there after a redeploy.

## Links

- Architectures: `linux/amd64` and `linux/arm64`, as published by the official image.
- Documentation: <https://github.com/louislam/uptime-kuma/wiki>
- Upstream: <https://github.com/louislam/uptime-kuma>
- Image: `docker.io/louislam/uptime-kuma`
- License: MIT (see <https://github.com/louislam/uptime-kuma/blob/master/LICENSE>).
