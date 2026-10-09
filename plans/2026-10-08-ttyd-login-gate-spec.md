# ttyd login gate: an InstaCloud sign-in page for the browser terminal templates

Status: approved direction (Carmen, 2026-10-08), not yet built.

## What

`claude-code`, `codex` and `pi` are a root shell in a browser. Today ttyd's own `-c user:pass` guards
them, so a visitor gets the browser's native HTTP basic auth dialog. Nothing on that dialog says
InstaCloud, it cannot carry a logo, and it looks like an error rather than a product.

These three templates get an InstaCloud sign-in page instead:

- One square card, centered. The InstaCloud wordmark on top, then "Sign in to `<template>`"
  (`claude-code`, `codex`, `pi`), then Username, Password with a show-password button, and a
  Sign In button.
- A strip along the bottom of the card: "Powered by InstaCloud", linking to `https://instacloud.com`.
- Light or dark, following the visitor's system setting. No toggle, no variable.
- A wrong username or password shows "Incorrect username or password" above the fields.
- Colors, type, spacing and components come from the same sources as the console: the
  `@insforge/ui` kit and this repository's copy of the console theme (`ui/src/styles.css`). Nothing
  on the page is a hand-picked hex.

The approved look is the "C. Light" and "C. Dark" boards of the design canvas
(https://claude.ai/artifact/MsvSAGQ81jWbUjbg63p1ai, private to the InstaCloud team account).

Nothing changes for the person who deploys: the same two variables (`ADMIN_USERNAME`,
`ADMIN_PASSWORD`), the same port (7681), the same health check. An existing instance upgrades by
redeploying the new version and signs in with the credentials it already has.

Out of scope: every other template, and a platform-level password gate in front of any service.

## Behaviour

| Request | Answer |
|---|---|
| A browser page load (`GET`, `Accept: text/html`) with no valid session | `200`, the sign-in page |
| Any other request with no valid session, including ttyd's `/token` and the WebSocket upgrade | `401`, empty body |
| `POST /_insta/sign-in` with the wrong username or password | `401`, the sign-in page with the error and the username still filled in, after a one second delay |
| `POST /_insta/sign-in` with the right ones | `303` to the page the visitor asked for, and a session cookie |
| Anything with a valid session | proxied to ttyd unchanged, WebSocket included |
| `GET /_insta/sign-out` | clears the cookie, `303` to `/` |

- The health check (`/`) keeps answering below 500 with or without a session, so deploys report
  healthy as they do today.
- A session lasts 30 days. It survives restarts and scale-to-zero wakes, because the cookie is
  signed with a key derived from the credentials, not a per-boot random. Changing
  `ADMIN_USERNAME` or `ADMIN_PASSWORD` (which needs a restart) signs every browser out.
- The page a visitor asked for is kept only when it is a same-origin path (starts with one `/`,
  not `//`). Anything else lands on `/`.

## How

### Two deliverables, two pull requests

1. **The gate** (this spec's first PR): `gate/` at the repository root, its tests, and a release
   workflow that publishes `insta-gate.mjs` and its SHA-256 to this repository's GitHub releases on a
   `gate-v<version>` tag.
2. **The three templates** (second PR, after `gate-v0.1.0` exists): each Dockerfile downloads that
   release file by version and checksum, the same way it downloads ttyd, and the entrypoint puts the
   gate in front of ttyd.

The order is forced. `templates-build-images.yml` builds every changed template in one parallel
matrix and tags versions only on `main`, so a template cannot consume an image or file that the
same push is still producing. A published release has no such race, which is why ttyd already works
this way.

### Process layout in the container

```
:7681 (routed, public)  node /usr/local/lib/insta-gate.mjs --name claude-code -- <ttyd command>
                          └─ spawns and supervises
127.0.0.1:7682          ttyd -i lo -p 7682 -W ... tmux -u new-session -A -s main
```

- The gate is the container's main process. It starts ttyd as its child, forwards `SIGTERM` and
  `SIGINT`, and exits with ttyd's status if ttyd exits, so the platform sees a crash as a crash.
- The gate opens the routed port only once ttyd answers on loopback. If ttyd stays up without
  listening for 30 seconds, the gate stops it and exits 1: a failed start, not a deploy that reports
  healthy while every signed-in request gets a 502.
- ttyd binds to loopback only and runs without `-c`. The gate is the only way in.
- The entrypoint keeps its "both variables are required" check. The 186-byte credential check goes:
  it existed because ttyd's `-c` silently stops matching past 186 bytes, and ttyd no longer sees the
  credential. The Dockerfile's ttyd checksum and log patch stay as they are.

### The gate file

`gate/src/server.mjs`, Node built-ins only (`node:http`, `node:net`, `node:crypto`,
`node:child_process`), so it runs on the `node:24-bookworm-slim` base the three templates already use
and needs no `npm install` in the image.

- **Credentials:** read from `ADMIN_USERNAME` and `ADMIN_PASSWORD`. Compared by HMAC-SHA256 digest
  with `crypto.timingSafeEqual`, so neither length nor content leaks through timing.
- **Session cookie:** `insta_gate=<expiry>.<signature>`, signature = HMAC-SHA256 over the expiry
  with a key derived from both credentials. `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when the
  request arrived over HTTPS (the platform router sets `X-Forwarded-Proto`; the self-hosted runtime
  can serve plain HTTP on localhost).
- **Sign-in POST:** form-encoded, at most 4 KB. Refused unless `Origin` (or `Sec-Fetch-Site`) is
  same-origin.
- **Proxy:** plain HTTP requests are piped to `127.0.0.1:7682` with the original method, path and
  headers, minus the session cookie. Upgrade requests are checked, then the raw sockets are joined.
- **Sign-in page headers:** `Cache-Control: no-store`, `X-Frame-Options: DENY`, and a CSP that
  allows only inline styles, `data:` fonts and images, and the one inline script by hash.
- **Logging:** one line at start (port, upstream, template name). Never a credential, never a
  cookie, never a submitted username.

### The sign-in page

Built once, at release time, into a string inside `insta-gate.mjs`. The server only substitutes the
template name and the error line.

- **Components:** `gate/page/build.mjs` renders the page with React's `renderToStaticMarkup`, using
  `@insforge/ui`'s own `Button` and `Input` and the console's Lucide icons, at the versions `ui/`
  locks (`@insforge/ui` 0.1.10, as the console). No React ships to the browser.
- **Styles:** a Tailwind v4 build of an entry that imports `ui/src/styles.css`, the repository's
  copy of the console's `globals.css` on top of the kit's `styles.css`. That brings the kit tokens
  (surfaces, text, borders, alpha overlays, destructive) and the console's InstaCloud overrides (the
  emerald `theme` on filled buttons, the squared radius scale) without restating a value. Surfaces
  map to tokens: page ground `semantic-1`, card `card`, bottom strip `semantic-1` with a `border`
  top rule, button `theme` with `inverse` text, error `destructive`.
- **Dark mode:** the kit and the console key dark mode on a `.dark` class. One small inline script
  sets it from `prefers-color-scheme`, follows changes, and drives the show-password button. With
  scripts off the page is light and the password stays hidden.
- **Font:** Inter, from the `@fontsource-variable/inter` package `ui/` already uses, latin subset,
  inlined as a data URI. System fonts are the fallback.
- **Logo:** the wordmark and its inverse, copied verbatim from the console's
  `public/instacloud-logo.svg` and the landing site's `public/brand/instacloud-wordmark-inverse.svg`,
  inlined, one shown per theme. The strip uses the square app icon the same way.

### Build, test, release

- The page builds from `ui/`'s installed dependencies (`npm --prefix ui ci`): its `@insforge/ui`,
  React, `lucide-react`, Tailwind and Inter, so the gate cannot drift from the dashboard's pins.
  `gate/package.json` (private) adds only `@tailwindcss/cli` at `ui/`'s Tailwind version. The root
  package gains nothing.
- `npm --prefix gate run build` writes `gate/dist/insta-gate.mjs`. `gate/dist/` is not committed.
- Server tests (`gate/test/*.test.mjs`) import only built-ins and run in the root `npm test`, like
  `templates/scripts/*.test.mjs` do. They start the gate against a fake upstream that speaks HTTP
  and WebSocket.
- `.github/workflows/gate.yml`: on pull requests touching `gate/`, install, build, test the built
  file. On a `gate-v*` tag, the same, then check the tag equals `gate/package.json`'s version and
  create the release with `insta-gate.mjs` and `insta-gate.mjs.sha256`. The existing
  `release-image.yml` listens on `v*`, which a `gate-v` tag does not match.

### The template change (second PR)

```dockerfile
# InstaCloud sign-in page in front of ttyd (gate/ in this repository, released as gate-v*)
ARG INSTA_GATE_VERSION=0.1.0
ARG INSTA_GATE_SHA256=<from the release>
RUN curl -fsSL -o /usr/local/lib/insta-gate.mjs \
        "https://github.com/InsForge/instacloud-oss/releases/download/gate-v${INSTA_GATE_VERSION}/insta-gate.mjs" \
    && echo "${INSTA_GATE_SHA256}  /usr/local/lib/insta-gate.mjs" | sha256sum -c -
```

- One checksum, not one per architecture: the file is JavaScript.
- Versions: `claude-code` 0.9.0 to 0.10.0, `codex` and `pi` 0.8.3 to 0.9.0.
- `templates/scripts/ttyd-patch.test.mjs` grows two checks: every ttyd template downloads the gate
  with the same pinned version and checksum, and none passes `-c` to ttyd or binds it publicly.
- Each README's "After deploy" says the URL opens an InstaCloud sign-in page.

## Verify

- Gate tests: no session gets the page or a 401 as in the table; wrong credentials get a 401 and the
  delay; right credentials get the cookie and the redirect; a forged or expired cookie is refused; a
  changed password invalidates old cookies; an off-origin POST is refused; `//evil` as a return path
  lands on `/`; the WebSocket upgrade is refused without a session and proxied with one; ttyd exiting
  ends the gate with its status.
- Built file: contains no `<script src`, no external URL except the two links, and its CSP hash
  matches its inline script.
- By hand, before the second PR merges: build `claude-code` locally, sign in through a real browser
  in light and dark (emulated `prefers-color-scheme`), run `claude` in the terminal, close the tab and
  reopen it into the same tmux session, wait for the platform to scale it to zero and wake it, and
  confirm the session survived.

## FAQ

**Why not a platform-level gate in front of every service?** It would cover more than three
templates, but it means a new access mode across the compute router, the platform API, the console
and the manifest. These three templates are the ones that hand out a root shell, and they can ship
now. A platform gate can replace this later without changing the page.

**Why a released file, not a shared image or three copies?** A shared image hits the parallel build
race above. Three copies kept identical by a test would work, but a release is how these templates
already consume ttyd, and updating the gate stays one place plus a version and checksum bump.

**Why not oauth2-proxy or Authelia?** Both work in front of ttyd. oauth2-proxy is a 20 MB binary
that still demands placeholder OAuth client credentials and a custom template to drop its "Sign in
with" button. Authelia's "Powered by Authelia" footer is hard-coded. A few hundred lines of
built-ins do the one job these templates need.

**Why the kit's `semantic-1` ground, not the console sign-in page's warm `#f4f2ee`?** The console's
auth shell writes `#f4f2ee` as a literal; it is not a token. Staying on tokens is the point of using
the kit, and it gives the dark theme a matching ground for free. Switching later is one class.

**Why keep the username?** The two variables already exist on every deployed instance. Dropping one
would make an upgrade change how people sign in.

**What happens when a session expires with the terminal open?** ttyd's page shows its reconnect
prompt and the reconnect is refused with a 401. Reloading the page shows the sign-in page. Changing
ttyd's own front end to do that automatically is out of scope.

**Is there brute-force protection?** A one second delay on every failed attempt. There is no lockout,
which would let anyone lock the owner out. Passwords are chosen by the deployer and required.
