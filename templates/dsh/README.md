# DeepSeek Harness

DeepSeek's plugin-composed coding agent, with its browser UI behind an auth gate.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/dsh)

> **This one needs a maintainer watching upstream.** DeepSeek Harness describes itself as a
> developer preview and says there will be compatibility-breaking changes, and the version pinned
> here is a release candidate whose transitive dependency ranges float, so the build resolves them
> as of a fixed date (`DSH_NPM_BEFORE` in the Dockerfile). Treat a version bump as a change that
> needs re-testing, not as a routine edit: `gate-assertions.mjs` in this directory is that
> re-test, and the image build asserts the env names and the client patch it depends on.

## Overview

This template runs [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), the
agent DeepSeek publishes as `@deepseek-ai/dsh`, in its browser UI mode. You open a URL,
authenticate, and get the harness web interface: sessions, a model picker, the agent's file and
shell tools, skills, plans, goals and subagents. The harness is composed entirely of plugins on
top of [Cordis](https://github.com/cordiverse/cordis), and `dsh plugin` is available in the
container for adding more.

The image is built from the Dockerfile in this directory: `node:24-bookworm-slim` (pinned by
digest), `nginx-light` from Debian, and `@deepseek-ai/dsh` pinned to an exact version. In front of
it sits the InstaCloud sign-in page, `insta-gate` from this repository's `gate/`, verified against
a pinned SHA-256. Nothing floats on `latest`, so a restart gives you the same environment.

**Why there is a sign-in page and an nginx in front.** The harness web UI has no authentication
of any kind, and it drives an agent that runs shell commands, so upstream refuses to bind it to
anything but loopback: `dsh web --host 0.0.0.0` exits with "intentionally not supported yet for
safety: it would expose remote code execution to the network". This template honours that. The
harness listens on `127.0.0.1:3080` exactly as upstream intends, and the sign-in gate in the same
container is the only process on the public port. Behind it, an nginx on loopback normalizes the
`Host` and `Origin` headers to the loopback authority, because the harness pins its settings,
credential and model-discovery calls to a loopback origin and would otherwise answer them with
403 from behind a public hostname.

**Why it runs as an unprivileged user.** The sign-in gate is the network boundary, and this is the
file one, which only exists because the container drops root. dsh wraps every shell command the
model runs in bubblewrap, binding `/` read-only and the session workspace read-write, and it passes
no `--unshare-user`. Run as root that contains nothing: the sandboxed process still holds
`CAP_SYS_ADMIN`, the kernel never locks the read-only binds, and a single `mount -o remount,rw`
takes the boundary apart. An agent asked to install a plugin found exactly that on its first
attempt, and installed it without the operator ever seeing the approval prompt that is supposed to
gate the write. The image therefore runs as `node`. bwrap is not setuid here, so it has to open a
user namespace to get that capability, the kernel locks every mount it inherits, and the same
remount answers `EPERM`. The volume is chowned to that user, and nginx gives up its `user`
directive, its pid file and its five temp paths to run without a root master.

**Why the image relaxes one client-side check.** Rewriting those headers is only half of what the
Settings and Models pages need, because the harness applies the same loopback test twice. The
server pins its 15 privileged RPCs to a loopback `Host`, which the rewrite above satisfies, and
the browser bundle separately reads the page's own `location.hostname`. When that is not loopback
the settings mirror is built in a memory-only mode where it never sends `settings.describe` at
all, and the Models page renders "settings are unavailable in this browser" with no request made
and no error logged. Upstream gives up there on the premise that a remote browser could not reach
those RPCs anyway, which is no longer true once the proxy normalizes `Host`, so the build rewrites
that one expression to a constant. It changes what the UI offers, not what the API allows: the
same RPCs are reachable through the gate either way, the gate in front of them is unchanged, and
the server's own refusal of cross-site requests is left alone. The build asserts the upstream
expression appears exactly once before rewriting it, so a version bump that restructures it fails
the image build instead of quietly shipping a dead Models page.

**Why the session is a cookie, and why another page cannot use it.** The UI receives everything
the agent does over two WebSockets, `/api/events.host` and `/api/events.mux`. `new WebSocket()`
takes no headers, so a browser can only authenticate that handshake with what its own network
stack attaches. Cached basic credentials were not enough there: Chromium and Firefox attach them,
WebKit sends none, and the agent's output then never reached the page. Every engine sends cookies
on a handshake, so signing in sets an `HttpOnly` session cookie and both streams work everywhere.
`SameSite` is scoped to the site rather than the host, though, and a sibling deployment here is
another tenant under the same domain, so its page counts as same-site and its requests carry the
cookie. The gate therefore refuses a handshake, or a `POST`, `PUT`, `PATCH` or `DELETE`, that
another page sends, port and scheme included. A session lasts 30 days, and rotating either
credential signs every browser out.

The agent runs unprivileged, but as the same uid as the gate. The shell commands the model chooses
run in a PID namespace of their own (bwrap's `--unshare-pid`), so they cannot see the gate's
process. What reads files as that uid outside the sandbox, the harness's own file tools included,
can still read the gate's environment, and the entrypoint's, under `/proc`: both hold
`ADMIN_USERNAME` and `ADMIN_PASSWORD`, while dsh and nginx start without them. That grants the agent
nothing it does not already have inside that container, but the credentials outlive the session that
read them, so rotating `ADMIN_PASSWORD` is the recovery path after any suspected compromise of the
agent.

## What you get by hosting it

- An HTTPS URL for the harness UI, behind an InstaCloud sign-in page, with no port forwarding or
  tunnel.
- A persistent volume mounted at `/data`. `DSH_HOME` is `/data/dsh` and `HOME` is `/data/home`, so
  settings, stored credentials, session history, installed plugins and your files survive
  restarts, redeploys and version upgrades.
- The sign-in credentials kept as service variables rather than baked into the image, so you can
  change them later without rebuilding anything.
- The machine size your plan gives a new compute service, because the template no longer asks for
  one of its own. You can move CPU and memory in both directions afterwards from the service
  settings; the template only ever set the size it was created at.
- Deploys are health-gated: a container that does not answer is rolled back to the last healthy
  image instead of leaving you with a dead URL.

## What you need before deploying

- A username and a password of your choosing for the UI sign-in. There is no default: the deploy
  form starts with both fields empty and will not submit until you fill them.
- Optionally, a [DeepSeek API key](https://platform.deepseek.com/). You can also leave it blank
  and store one from the UI's Models page after deploy, which keeps it editable in the UI.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | Username for the InstaCloud sign-in page in front of the UI. You pick it at deploy. |
| `ADMIN_PASSWORD` | yes | Password for the InstaCloud sign-in page in front of the UI. You pick it at deploy. Nothing is generated for you, because this credential fronts an agent that runs shell commands. |
| `DEEPSEEK_API_KEY` | no | The key the agent uses for model calls and for its `web_search` tool. Leave blank to store one from the Models page instead. |
| `DEEPSEEK_BASE_URL` | no | Points the DeepSeek adapter at a gateway or compatible proxy. Defaults to `https://api.deepseek.com`. |
| `DSH_PERMISSION_MODE` | no | The agent's starting file boundary: `read-only`, `workspace-write` (the default), or `danger-full-access`. It is a default, not a lock: the composer has a picker that changes it per conversation, and the agent may ask you to widen it for one command, which is how installing a plugin is meant to work. |

There is deliberately no `GIT_TOKEN`. Earlier revisions of this template advertised one, but
nothing in the harness reads that name, so it configured nothing. To clone a private repository,
give the agent a URL carrying the token, or write a credential helper under `/data/home`.

Set by the template, not by you: `DSH_HOME=/data/dsh` and `HOME=/data/home` (put all harness
state on the volume), and `DSH_TELEMETRY_DISABLED=1`. Session telemetry is already off by default
(`DSH_TELEMETRY_MODE` defaults to `DISABLED`); this disables the row outright. It stops telemetry
export only, and does not suppress feedback acknowledgement or the DeepSeek provider header.

One thing to know about `DEEPSEEK_API_KEY`: the harness resolves credentials from the process
environment first, and that layer is deliberately read-only, so a key supplied as a template
variable shows in the Models page as configured but not editable there. Rotate it by editing the
service variable. If you would rather manage the key in the UI, leave the variable blank; the
key you store then lives in `$DSH_HOME/.credentials.yaml` on the volume.

## After deploy

1. Open the service URL. An InstaCloud sign-in page asks for the `ADMIN_USERNAME` and
   `ADMIN_PASSWORD` you chose at deploy. The session lasts 30 days, and changing either variable
   signs every browser out.
2. You land in the harness UI with no sessions yet. Start one; it opens with the `standard` agent
   preset, which is the full coding agent.
3. If you left `DEEPSEEK_API_KEY` blank, open Settings and then Models, and store your key
   there. The harness is built for this order: you can browse the model catalogue, store the
   key, and prompt, with no restart in between.
4. Each session picks its own workspace directory, from a browser rooted at `Home` (`/data/home`).
   A `workspace` folder is waiting there; make others beside it if you want a directory per
   project. That choice is also the agent's write boundary: under the default `workspace-write`
   it may read the rest of the container but write only inside the workspace you picked.
5. Session history, settings and stored credentials are under `/data/dsh` and survive restarts.
   They sit outside every workspace on purpose, so the agent cannot rewrite its own credentials or
   its own permissions without asking you first. Anything written outside `/data` is lost when the
   container is replaced.

The four agent presets shipped by upstream (`standard`, `code`, `minimal`, `cordis`) carry
Chinese names and descriptions in the preset picker. The rest of the UI follows your browser's
language, and you can pin it from Settings.

## Links

- Architectures: `linux/amd64` and `linux/arm64`. The node base image, bubblewrap and the
  ripgrep the harness bundles are all available for both.
- Upstream: <https://github.com/deepseek-ai/deepseek-harness>
- Package: [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)
- Cordis: <https://github.com/cordiverse/cordis>
- License: DeepSeek Harness is MIT. The Dockerfile, nginx config and manifest in this directory
  are part of this repository. "DeepSeek Harness" is a registered trademark of DeepSeek, used
  here only to name the software this template deploys.
