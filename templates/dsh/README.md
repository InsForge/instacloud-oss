# DeepSeek Harness

DeepSeek's plugin-composed coding agent, with its browser UI behind an auth gate.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/dsh)

> **This one needs a maintainer watching upstream.** DeepSeek Harness describes itself as a
> developer preview and says there will be compatibility-breaking changes, and the version pinned
> here is a release candidate whose transitive dependency ranges float. Treat a version bump as a
> change that needs re-testing, not as a routine edit: `gate-assertions.mjs` in this directory is
> that re-test, and the image build asserts the env names and the client patch it depends on.

## Overview

This template runs [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), the
agent DeepSeek publishes as `@deepseek-ai/dsh`, in its browser UI mode. You open a URL,
authenticate, and get the harness web interface: sessions, a model picker, the agent's file and
shell tools, skills, plans, goals and subagents. The harness is composed entirely of plugins on
top of [Cordis](https://github.com/cordiverse/cordis), and `dsh plugin` is available in the
container for adding more.

The image is built from the Dockerfile in this directory: `node:24-bookworm-slim` (pinned by
digest), `nginx-light` from Debian, and `@deepseek-ai/dsh` pinned to an exact version. Nothing
floats on `latest`, so a restart gives you the same environment.

**Why there is an nginx in front.** The harness web UI has no authentication of any kind, and it
drives an agent that runs shell commands, so upstream refuses to bind it to anything but
loopback: `dsh web --host 0.0.0.0` exits with "intentionally not supported yet for safety: it
would expose remote code execution to the network". This template honours that. The harness
listens on `127.0.0.1:3080` exactly as upstream intends, and an nginx in the same container is
the only process on the public port. It requires HTTP basic auth, and it normalizes the `Host`
and `Origin` headers to the loopback authority, because the harness pins its settings,
credential and model-discovery calls to a loopback origin and would otherwise answer them with
403 from behind a public hostname.

**Why it runs as an unprivileged user.** nginx is the network boundary; this is the file one, and
it only exists because the container drops root. dsh wraps every shell command the model runs in
bubblewrap, binding `/` read-only and the session workspace read-write, and it passes no
`--unshare-user`. Run as root that contains nothing: the sandboxed process still holds
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

**Why the gate hands out a cookie.** The UI receives everything the agent does over two
WebSockets, `/api/events.host` and `/api/events.mux`. `new WebSocket()` takes no headers, so a
browser can only authenticate that handshake with credentials its own network stack attaches, and
nothing requires an engine to reuse its HTTP auth cache there. Measured with a page holding valid
basic credentials, Chromium and Firefox attach them to the handshake and WebKit sends none. Where
they are not attached both handshakes answer 401, the client retries them forever, and the agent's
output never reaches the page, even though the page itself and every RPC on it are authenticated
normally. So the gate mints a cookie on the authenticated responses that do not already carry one,
and accepts it in place of the password on a WebSocket handshake and nowhere else. Its value is a
digest of the admin credentials, so rotating either one invalidates every cookie issued under the
old pair, and it is `HttpOnly` and `SameSite=Strict`, so no script can read it and it is never
attached to a cross-site request. `SameSite` is scoped to the site rather than the host, though,
and a sibling deployment here is another tenant under the same domain, so its page counts as
same-site. Cookies ignore ports too, so a second app on another port of one hostname is the same
case again. The gate therefore refuses any handshake whose `Origin` is not this deployment's own,
port included, which covers both the cookie and the basic credentials a browser attaches from its
own auth cache. Ordinary requests are unaffected: they still need the password.

The agent runs unprivileged, but as the same uid as nginx, which is what lets nginx read the
credentials without a shared group. So the shell commands the model chooses can still read the
gate's password file and the cookie token derived from it, even though the entrypoint unsets
`ADMIN_USERNAME` and `ADMIN_PASSWORD` before starting anything, and even though the sandbox mounts
that directory read-only: read-only is not unreadable. Neither grants the agent more than it
already has inside that container, but they outlive the session that read them, so rotating
`ADMIN_PASSWORD` is the recovery path after any suspected compromise of the agent.

## What you get by hosting it

- An HTTPS URL for the harness UI, gated by HTTP basic auth, with no port forwarding or tunnel.
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
| `ADMIN_USERNAME` | yes | HTTP basic-auth username for the UI. You pick it at deploy; it may not contain a colon. |
| `ADMIN_PASSWORD` | yes | HTTP basic-auth password for the UI. You pick it at deploy; nothing is generated for you, because this credential fronts an agent that runs shell commands. |
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

1. Open the service URL. The browser asks for HTTP basic auth: the `ADMIN_USERNAME` and
   `ADMIN_PASSWORD` you chose at deploy.
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
