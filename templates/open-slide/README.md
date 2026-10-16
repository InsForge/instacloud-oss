# open-slide

A hosted open-slide workspace: React slide decks, an in-browser editor, and present mode.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/open-slide)

## Overview

[open-slide](https://github.com/open-slide/open-slide) is a slide framework where every deck is
ordinary React. A page is a component rendered into a fixed 1920x1080 canvas, and the framework
handles scaling, navigation, hot reload, present mode and export. It ships to npm as
`@open-slide/core` (the runtime, the Vite plugin and the `open-slide` CLI) and `@open-slide/cli`
(the `init` scaffolder); there is no server product and no public image, so this template builds
one.

The image is built from the Dockerfile in this directory: `node:24-bookworm-slim` pinned by
digest, `nginx-light` from Debian, and a workspace scaffolded by running upstream's own
`npx @open-slide/cli init`, with `@open-slide/core` then pinned to an exact version. What deploys
is the same workspace `init` creates on a laptop, served over HTTPS. Nothing floats on `latest`,
so a restart gives you the same environment.

**What runs is upstream's dev server, not an app this repository wrote.** `open-slide dev` is a
Vite dev server, and in open-slide that is the product surface: the deck browser, the slide
viewer, present mode, the element inspector, the assets manager and the theme gallery are all
served by it, and its API writes your edits back into the deck's source files.

**Why there is an nginx in front.** The dev server has no authentication of any kind, and its API
writes files: `/__edit` rewrites a slide's source, `/__slides` duplicates and deletes decks,
`/__assets` accepts uploads, and `/__update-package` runs a package install. Upstream's assumption
is a port on your own machine. So the dev server listens on `127.0.0.1:5173` and an nginx in the
same container is the only process on the public port, requiring HTTP basic auth on every request.
It passes `Host` and `Origin` through untouched, because the dev server compares those two itself
and refuses a cross-site write, which is the only CSRF defence those endpoints have.

**Why the gate hands out a cookie.** The editor receives every change over Vite's HMR WebSocket,
and `new WebSocket()` takes no headers, so a browser can only authenticate that handshake with
credentials its own network stack attaches. Chromium and Firefox attach cached basic credentials
there; WebKit does not (measured for the `dsh` template in this registry). Without it the page
stays on the old render while edits land on disk. So the gate mints an `HttpOnly`,
`SameSite=Strict` cookie on authenticated responses and accepts it in place of the password on a
WebSocket handshake and nowhere else. Its value is a digest of the admin credentials, so rotating
either one invalidates every cookie issued under the old pair, and a handshake whose `Origin` is
not this deployment's own is refused outright.

**What this template does not include is an agent.** open-slide's authoring story is that a coding
agent writes the React: the scaffolded workspace ships `/create-slide`, `/slide-authoring` and
`/apply-comments` skills for exactly that, and they are in the image. Nothing in this container
runs them, because an agent needs a model key and a shell, and this is neither. What you get
without one is everything the browser can do on its own, which is most of the product: browse and
present decks, edit text and styles by clicking an element, swap images, upload assets, duplicate
and reorganise decks, and export to HTML, PDF or PPTX. Writing a new deck from a prose brief needs
an agent pointed at `/data/slides`, and the comments you leave in the inspector are markers in the
source waiting for one.

## What you get by hosting it

- An HTTPS URL for the open-slide editor and present mode, gated by HTTP basic auth, with no port
  forwarding or tunnel.
- A persistent volume mounted at `/data`. `slides/`, `themes/` and `assets/` live there, so your
  decks, your uploads and your themes survive restarts, redeploys and version upgrades. The
  workspace itself, its `node_modules` and the pinned runtime stay in the image, with
  `/data/node_modules` linked at the workspace's copy so a deck's `import … from
  '@open-slide/core'` resolves from where the file actually sits.
- A deck to start from: the `getting-started` deck upstream's scaffolder writes is copied onto the
  volume on first boot.
- The sign-in credentials kept as service variables rather than baked into the image, so you can
  change them later without rebuilding anything.
- The machine size your plan gives a new compute service. The template asks for none of its own,
  and you can move CPU and memory in both directions afterwards from the service settings.
- Deploys are health-gated: a container that does not answer is rolled back to the last healthy
  image instead of leaving you with a dead URL.

## What you need before deploying

- A username and a password of your choosing for the editor sign-in. There is no default: the
  deploy form starts with both fields empty and will not submit until you fill them.

That is all. Everything else is configured in the app after deploy.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | HTTP basic-auth username for the editor. You pick it at deploy; it may not contain a colon. |
| `ADMIN_PASSWORD` | yes | HTTP basic-auth password for the editor. You pick it at deploy; nothing is generated for you, because this credential fronts an editor that writes files to the volume. |

Set by the image, not by you: the three content directories point at `/data` through
`open-slide.config.ts`, the dev server binds `127.0.0.1:5173` behind nginx, and
`OPEN_SLIDE_SKIP_SKILLS_CHECK=1` silences the start-up comparison between the workspace's copy of
the built-in agent skills and the runtime's, which the image pins together anyway.

## After deploy

1. Open the service URL. The browser asks for HTTP basic auth: the `ADMIN_USERNAME` and
   `ADMIN_PASSWORD` you chose at deploy.
2. You land on the deck browser with the `getting-started` deck on it. Open it to get the viewer,
   and press the present control for fullscreen playback; `/presenter` gives you the presenter
   view with the next slide, speaker notes and a timer.
3. Click any element in the viewer to open the inspector. Text, colours, spacing and images are
   editable there, and each change is written straight into `slides/<id>/index.tsx` on the volume.
   A change you would rather describe than make goes in as a comment, which is stored as an
   `@slide-comment` marker in the same file for an agent to apply later.
4. Upload images, video and fonts from the assets panel, per deck or globally. The svgl catalogue
   is searchable from there for brand logos. Uploads are capped at 25 MB each by the app.
5. Export from the slide menu: a self-contained static HTML site, a PDF, or a PPTX with native
   text boxes and shapes. The PPTX conversion runs entirely in your browser.
6. To author from a prose brief, point a coding agent at `/data/slides` over your own channel; the
   skills it needs are in the image at `/opt/open-slide/.claude/skills`. Anything written outside
   `/data` is lost when the container is replaced.

Two things to expect on a cold start. The service scales to zero, so the first request after an
idle period wakes the machine; nginx takes the public port only once the dev server is listening
behind it, so that request waits rather than failing. And the first deck you open after a boot
takes a few seconds while Vite prebundles its dependencies, reloading the page itself once when it
finishes. Later loads are immediate.

The editor's "update open-slide" action installs a newer runtime into the container's own
filesystem, not the volume, so it is undone by the next restart. Treat the pinned image as the
version you are running, and a template version bump as how it moves.

## Links

- Architectures: `linux/amd64`. Everything the image installs is JavaScript on a multi-arch node
  base, but the npm install pulls the per-platform native bindings Vite 8 and Tailwind 4 ship, and
  nobody has run that install for `arm64` yet.
- Upstream: <https://github.com/open-slide/open-slide>
- Site and docs: <https://open-slide.dev>
- Packages: [`@open-slide/core`](https://www.npmjs.com/package/@open-slide/core),
  [`@open-slide/cli`](https://www.npmjs.com/package/@open-slide/cli)
- License: open-slide is MIT. The Dockerfile, nginx config, workspace config and manifest in this
  directory are part of this repository.
