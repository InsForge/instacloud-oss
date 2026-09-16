# InstaCloud OSS

The open-source InstaCloud runtime: one daemon over your Docker that answers the same API the
hosted platform answers. Serverless on a single machine, branches that fork the disk, and the same
`insta` CLI, MCP server and agent skills on both sides.

```
project = a Postgres database + an S3 bucket + your app containers
branch  = a disposable, fully isolated clone of all three
```

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[Install on a VPS](#install-on-a-vps) · [Run on your laptop](#run-on-your-laptop) ·
[insta CLI](https://github.com/InsForge/instacloud-cli) · [Hosted InstaCloud](https://instacloud.com) ·
[Discord](https://discord.com/invite/MPxwj5xVvW)

## Install on a VPS

Ubuntu 22.04+ or Debian 12+, 2 vCPU, 2 GiB RAM, 15 GiB free disk, and the ports 80, 443, 8080,
8081, 5432, 6379 and 27017 free. The installer checks all of that before it changes anything: a
busy port names the key that moves it, and a first install on a box under the memory or disk
minimum stops there rather than failing later under load. As root:

```bash
curl -fsSL https://raw.githubusercontent.com/InsForge/instacloud-oss/main/install.sh | sh
```

It pulls `ghcr.io/insforge/instacloud`, published for linux/amd64 and linux/arm64. Re-run the same
command to upgrade, or add `--version v0.1.0` to pin a release.

The script installs Docker if it is missing, prepares a reflink-capable data directory, and
starts three containers: the daemon, the TLS edge, and the object store. It prints where to go:

```
  Setup:    https://console.<domain>/setup
  CLI:      insta login --api-key <token from the setup page> --api-url https://api.<domain>
```

Open the setup URL, create the one admin account, copy an API token, and point the CLI at the box.
Then deploy something to see it work end to end:

```bash
insta project create demo
insta template deploy hermes
```

With no `--domain` the installer uses the public IP of the box as an sslip.io name, so URLs work
immediately. Apps land on `https://<group>-<project>-<branch>.<domain>` and databases on
`pg-<name>-<project>-<branch>.<domain>:5432`.

Full details, including firewalls, reflinks and your own domain:
[docs.instacloud.com/self-hosting](https://docs.instacloud.com/self-hosting/overview).

## Run on your laptop

Prerequisites: Docker (running) and Node 22 or newer. No cloud account, no API keys, no auth.

```bash
git clone https://github.com/InsForge/instacloud-oss.git && cd instacloud-oss
npm install
npm run build:ui        # optional: the dashboard, served by the daemon itself
npm run dev             # the daemon on http://127.0.0.1:8080  (INSTA_OSS_PORT to change)
```

First run pulls `postgres:16-alpine`, `dxflrs/garage` and `rclone/rclone`; give it a minute. State
lives in `~/.insta-oss/`.

In another terminal, install the CLI and point it at the daemon:

```bash
npm install -g insta
export INSTA_API_URL=http://127.0.0.1:8080      # the CLI defaults to the cloud
```

No `insta login`: the daemon trusts loopback. Skip `insta setup agent`, which registers the cloud's
MCP server; the dashboard's Quick Start page prints this box's own setup steps. App URLs are
`http://<group>-<project>-<branch>.localhost:8080`.

## What it looks like

A session against a server-mode box on `example.com`. On a laptop the same commands print
`http://web-demo-main.localhost:8080` for the app and a `127.0.0.1:<port>` DSN, because local mode
has no domain and no TLS.

```bash
$ cd ~/my-app                       # the CLI links the project to your cwd
$ insta project create demo
created project 4496c3e1-… (demo)
  resources: []

$ insta services add postgres db
$ insta services add storage store
$ insta secrets --print             # the branch's credentials (gated: secrets.read)
DATABASE_URL="postgres://postgres:…@pg-db-demo-main.example.com:5432/app?sslmode=require"
AWS_ACCESS_KEY_ID="GK…"  AWS_SECRET_ACCESS_KEY="…"  AWS_ENDPOINT_URL_S3="https://s3.example.com"
BUCKET_NAME="io-demo-main-store"

$ insta deploy --image nginx:alpine --port 80 --group web
deployed nginx:alpine -> https://web-demo-main.example.com (branch main, group web)

$ insta branch create feat          # forks the db files and the volumes
created branch feat in 0.9s         # feat sleeps until its first request

$ insta compute always-on off web   # main is always-on by default; opt this one into scale-to-zero
$ insta compute status web          # five idle minutes later
web  desired=running  live=suspended

$ curl -s https://web-demo-main.example.com/ | head -1   # a request wakes it in ~2s
<!DOCTYPE html>

$ insta branch delete feat          # done with the task: throw the clone away
```

`insta manifest` shows each branch's db, storage and compute with their URLs.

## What makes it different

**A branch is a fork of the disk.** `insta branch create` reflink-copies the Postgres data
directory and every compute volume, copies the bucket, and redeploys the apps on their own URLs.
A sleeping database, which is what a branch's parent usually is, forks in about a second whether
it holds 100 MB or 100 GB; one that is awake is streamed with `pg_basebackup` instead, which is
correct but takes time proportional to its size. The source is never touched either way. One task,
one branch, many in parallel.

**Serverless on one node.** On your default branch, apps and managed databases (Redis, MySQL,
MongoDB) are always-on, like the hosted platform. Postgres and everything on a branch clone scale to
zero: an idle one is stopped, not billed to your RAM, and the next request starts it again in a
second or two. That is what lets one box hold dozens of branches. Any of these can be switched per
service: `insta compute always-on off web`.

**Governance at the credential boundary.** The daemon is the only thing holding credentials, and
every sensitive action passes an allow, deny or approve gate before it touches a resource. Agents
propose, humans approve: a gated action parks until someone runs `insta approvals approve`, and an
agent that ignores its instructions still cannot get past it. Every action lands in the
`insta events` audit timeline.

## How it works

Every request flows CLI/MCP/dashboard, then the HTTP server (routes plus the govern gate), then
the engine, then an adapter, then Docker:

- **router** (`src/router/`): one process listening for everything. HTTP by `Host`, Postgres,
  Redis and MongoDB by the name in the TLS handshake, MySQL on a port per service. It holds the
  connection while a sleeping service wakes.
- **scheduler** (`src/scheduler.ts`): the sleep and wake state machine, the idle sweep, the memory
  pressure pass, and one operation lock per service.
- **engine** (`src/engine.ts`): project and branch lifecycle, from provision through the fork to
  teardown with compensation on failure.
- **govern** (`src/govern.ts`): the policy engine, with gated actions, allow/deny/approve per
  project, one-shot grants, and an HTTP 202 approval flow.
- **adapters** (`src/adapters/`): swappable providers behind small contracts. `LocalPostgres` (a
  container and a data directory per branch), `LocalGarage` (a bucket per storage service),
  `DockerCompute` (your image per compute group), `LocalManagedDb` (private Redis, MySQL and
  MongoDB containers per branch).
- **data dir** (`src/datadir.ts`): where every byte lives, `pg/`, `vol/`, `md/`, `garage/`, keyed
  by immutable ids.
- **state** (`src/state.ts`): a single JSON file with a process lock beside it.

Command-by-command CLI and MCP compatibility: [COMPATIBILITY.md](COMPATIBILITY.md).

## Dashboard

The daemon serves a web UI at its own URL: one process, same origin. On a server it starts at
`/setup` (one admin account), signs in at `/login`, and mints API tokens on the Account page. On a
laptop there is no login at all.

It matches the hosted InstaCloud console: a Service canvas (or list) with status and a Wake button
for a sleeping one, Observability, Secrets, Branches, Quick Start and a Settings panel, an
Activities side panel with notifications, and a service's own detail as an overlay with Metrics,
Variables, Runtime Logs and Settings. Postgres adds a Database tab, which offers Wake and browse
while the database sleeps rather than waking it on sight; apps add Volume;
every database has Connect, with its connection string, a client command and the `insta` line.
Add Service covers a Docker image, an empty service, Postgres, Redis, MySQL, MongoDB, object
storage and View Templates. Variables lists the names a service actually receives, never the
values: read those with `insta secrets --print`, or a database's through Connect. An empty project
shows the connect-agent panel with this box's CLI setup. Gated actions from the UI go through the
same 202 and approve flow as the CLI.

![The Service page, showing a live project](docs/img/dashboard-services.png)

Locally: `npm run build:ui` once, then open http://127.0.0.1:8080. UI development:
`cd ui && npm run dev` (Vite on :5173, proxying API calls to the daemon).

## Using it with agents

`insta project create` (or `link`) installs the insta agent skills into your project (gitignored;
`.claude/skills/` for Claude Code, `.agents/skills/` for Codex), so a coding agent opened in the
repo already knows the workflow: one task, one branch, deploy, verify, delete. You keep the
approval power, by setting an action to `approve` under Settings > Agent Governance in the dashboard or through
`PUT /projects/:id/policy/:action`, and the audit trail (`insta events`). The insta-mcp server is a
thin client over the same endpoints; point it at the daemon with
`PLATFORM_API_URL=https://api.<domain>` and an `insta_` token.

## Templates

A template is one folder in [`templates/`](templates/) describing an app someone can deploy in a
single command: a manifest pinning the image and declaring its variables, plus a README and a logo.
The published ones show up in the [gallery](https://instacloud.com/templates).

The daemon serves that directory through the same `/templates` routes the hosted platform uses, so
`insta template list` and `insta template deploy <code>` work with no internet access.

Adding one is a single pull request here. [templates/README.md](templates/README.md) has the
layout, and [templates/AGENTS.md](templates/AGENTS.md) has the rules CI enforces.

The **Deploy on InstaCloud** button those READMEs carry is in [assets/](assets/README.md), free
for any repository to use: one SVG that covers light and dark, sized to sit in a row of deploy
buttons, plus the snippet to paste and the script that regenerates it.

## Compatibility

[COMPATIBILITY.md](COMPATIBILITY.md) is the command-by-command table: what works, what differs by
run mode, and what answers 501 with guidance instead of pretending.

## Tests

`npm test` needs no Docker. It does use the `openssl` CLI for the TLS cases (Node can parse an
X.509 certificate but not issue one, and these cases mint pairs with particular SANs and
validity windows); where openssl is absent those cases are skipped by name and the rest of the
suite runs.

```bash
npm test                                       # contract tests, fake adapters, no Docker
RUN_DOCKER_TESTS=1 npx vitest run test/clone-isolation.int.test.ts   # one Docker file at a time
sh e2e/local-smoke.sh                          # the whole public surface, real CLI, real Docker
```

The isolation tests prove clone independence for real: writes to a branch's database and bucket
never reach the source. [e2e/README.md](e2e/README.md) covers the end-to-end scripts and what they
deliberately do not cover.

## Cleanup

On a laptop:

```bash
insta project delete                                        # per project (approval is opt-in: set project.delete to approve in the dashboard)
docker ps -aq --filter name=io- | xargs docker rm -f        # every InstaCloud OSS container
docker volume rm io-garage-meta io-garage-data              # the shared object store data
rm -rf ~/.insta-oss                                         # daemon state
```

On a server, stop the stack instead and keep the data:

```bash
cd /etc/instacloud && docker compose down
```

Removing the install completely, data and mounts included, is
[Uninstall](docs/self-hosting/install.mdx#uninstall).

To remove only the project containers there, filter by project so the stack itself survives:

```bash
docker ps -aq --filter name=io-<project>- | xargs docker rm -f
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the code map and the rules every change follows. Two
good entry points: a provider adapter (implement one interface from `src/types.ts` as a new file in
`src/adapters/`, wire it in `src/main.ts`, and nothing else changes), or a
[template](templates/README.md), which needs no knowledge of the daemon at all.

## Community

- [Discord](https://discord.com/invite/MPxwj5xVvW): questions and support
- [X / Twitter](https://x.com/InsForge): release updates
- [info@insforge.dev](mailto:info@insforge.dev)

## License

Apache-2.0. See [LICENSE](LICENSE).
