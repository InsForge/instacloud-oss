# Umami

Privacy-first web analytics without cookies.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/umami)

## Overview

[Umami](https://github.com/umami-software/umami) is a self-hosted alternative to Google Analytics.
You add one small script tag to a site, and Umami records page views, referrers, countries, devices
and custom events, then shows them on a dashboard. It sets no cookies and stores no IP addresses:
a visitor is identified by a hash of their IP, user agent and the site id, salted with a value that
rotates, so the same person on the same site is one session today and an unrelated one next month.

This template runs the official `ghcr.io/umami-software/umami` image. The overlay image it builds
adds two scripts and changes nothing about the application; upstream's Next.js build, its Prisma
migrations and its server are all untouched. The entrypoint runs upstream's own startup sequence
with two steps in front of it:

- **It replaces the seeded admin credential.** Umami has no sign-up page. Its first migration
  inserts one account, `admin`, with the bcrypt hash of the password `umami`, which is in the
  public repository. The entrypoint writes the `ADMIN_USERNAME` and `ADMIN_PASSWORD` you deployed
  with over that row before the server accepts a request, and only while the account is still on
  that seeded password, so a password you change in Umami's own UI survives a restart.
- **It derives `TWO_FACTOR_ENCRYPTION_KEY`** from `APP_SECRET` when you have not supplied one.
  Umami wants exactly 64 hex characters there and the platform's generator emits base64url, so
  without this two-factor auth would be switched off on every deployment.

Analytics data lives in the managed Postgres service the template provisions alongside it. The web
service keeps nothing on disk and has no volume.

## What you get by hosting it

- An HTTPS URL for both halves of Umami: the dashboard a human opens, and `/api/send`, the endpoint
  the tracker script on your sites posts to.
- A managed Postgres database, provisioned and wired in by the template. Umami's migrations run on
  every boot, so an upgrade of this template migrates the schema on the way up.
- An admin account on credentials you choose at deploy, instead of the one upstream seeds.
- Two-factor auth available out of the box, on a key derived per deployment.
- Your visitors' analytics on infrastructure you control, with no third-party script on your pages
  and no cookie banner for this (Umami sets no cookies on the sites it tracks).
- The machine idle-stops and wakes on the next request, so a dashboard you open a few times a week
  is not billed around the clock.

## What you need before deploying

- A username and a password of your choosing. There is no default and nothing is generated: the
  deploy form starts with both fields empty and will not submit until you fill them. A password the
  platform minted would be one it could never show you again, because a template variable is stored
  write-only.
- A website you can add a script tag to, if you want it to record anything. The dashboard works
  without one, it just has nothing to show.

That is all. Everything else, including the websites you track and any further users, is set up
inside Umami after deploy.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | Username for the admin account. You choose it; it replaces the `admin` account upstream seeds. |
| `ADMIN_PASSWORD` | yes | Password for that account. You choose it. It is the only gate in front of the URL. |
| `TWO_FACTOR_ENCRYPTION_KEY` | no | Encrypts stored TOTP secrets. Exactly 64 hex characters, from `openssl rand -hex 32`. Left empty, the entrypoint derives a stable one from `APP_SECRET`, so two-factor auth works either way. |
| `DISABLE_TELEMETRY` | no | Set to `1` to stop Umami reporting anonymous usage to umami.is. Unset by default, which is upstream's default. |
| `TRACKER_SCRIPT_NAME` | no | Comma-separated alternative names to serve the tracker script under, such as `stats,analytics`, for sites where an ad blocker drops `/script.js`. |
| `CLIENT_IP_HEADER` | no | Request header to read the visitor's IP from. Only needed if something in front of this service puts the real IP somewhere other than `x-forwarded-for`. |

Set by the template, not by you: `DATABASE_URL` points at the managed Postgres service, `APP_SECRET`
is a generated 64-character secret that signs the session cookie and seeds the visitor salt, and
`HOSTNAME` / `PORT` pin the Next.js server to the routed port.

## After deploy

1. Open the service URL. Umami redirects to `/login`; sign in with the `ADMIN_USERNAME` and
   `ADMIN_PASSWORD` you deployed with.
2. Go to **Settings → Websites → Add website**, give it a name and the domain you want to track,
   and save. Umami shows you a tracking code that looks like this, with your own URL and id:

   ```html
   <script defer src="https://<your-url>/script.js" data-website-id="<website-id>"></script>
   ```

3. Paste that into the `<head>` of the site you want to track and deploy it.
4. Load a page on that site, then open the website in Umami. The view appears within a few seconds;
   **Realtime** shows it first.

To record something other than a page view, call `umami.track('signup')` from your own JavaScript;
the events show under the website's **Events** tab.

If you would rather not wait for real traffic to check the deployment, post one page view yourself:

```bash
curl -s -X POST "https://<your-url>/api/send" \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: Mozilla/5.0' \
  -d '{"type":"event","payload":{"website":"<website-id>","hostname":"example.com","url":"/hello","title":"Hello"}}'
```

Umami answers with a token and the view shows up on the dashboard.

## Links

- Upstream: <https://github.com/umami-software/umami>, pinned at `3.4.0`
- Image: `ghcr.io/umami-software/umami:3.4.0`, with this directory's `Dockerfile` on top
- Documentation: <https://umami.is/docs>
- License: MIT
