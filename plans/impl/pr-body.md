Makes insta-oss a single-node serverless runtime with the cloud's experience, per the spec committed in `plans/2026-09-08-single-node-serverless-spec.md`. Still a draft: what is left for you is at the bottom, and one of those items is the only thing standing between this branch and a stranger being able to install it.

Two rules held throughout: the daemon adds **no endpoint the cloud lacks** (every new route exists in the platform's surface and was a 501 stub here), and local mode behaves exactly as it does today, so a laptop never regresses.

## What it does now

- **Identity.** First visit is a setup page that creates the admin. Cookie sessions for the dashboard, `insta_` tokens through the cloud's `/tokens` routes, a bearer and session guard on everything outside a small allowlist, and a write lock on the state file.
- **Real URLs.** A router owns hostnames: `<group>-<ref>.<domain>` for compute, `pg-<name>-<ref>` for databases. HTTP routes by Host, and a pg-wire lane terminates TLS and routes by SNI. Nothing is published beyond loopback in local mode. Custom domains use the cloud's `compute/domain` routes.
- **Sleep and wake, the cloud's rules.** One activity stamp per service, a sweep every 30 s, and the same four wake doors. Sleep is `docker stop` with a SIGTERM grace, never pause, so RAM is actually freed. Databases sleep too and wake on connect. Memory-pressure eviction sleeps the least recently active service when the box runs low.
- **Branching by fork.** Postgres data and compute volumes are bind mounts on a reflink filesystem, so a branch is a checkpoint plus a reflink copy, with a streaming `pg_basebackup` fallback where reflinks are unavailable. The installer provisions a reflink-capable volume when the root filesystem cannot do it.
- **Templates and parity.** The bundled catalog is served through the cloud's template routes. Projects start empty like the cloud, and a project can hold several Postgres and storage services. Every template declares the architectures it supports.
- **Packaging.** A daemon image, a compose stack and a one-line installer that checks the box's sizing, refuses busy ports, provisions the data directory, and prints the setup URL. Re-running it is the upgrade.
- **Dashboard and docs.** Setup, login, tokens, a deploy dialog for images and templates, a templates gallery, service detail with domains, and sleep state with a wake action. Six self-hosting pages and a public e2e directory.

## Verification

Four environments: this laptop, a Docker-in-Docker Linux host, and two throwaway t3.small Ubuntu boxes on EC2.

| Check | Result |
|---|---|
| Fake-adapter suites | 519 tests, 30 files |
| Container suites | 10, green on macOS and on Linux |
| `e2e/local-smoke.sh` | green from a fresh data directory |
| typecheck, lint, `build:ui`, `shellcheck install.sh` | clean |

**The headline claim, measured on a 1.9 GiB t3.small.** A project with **26 branches**: all **53 branch containers asleep**, only the three stack containers running, about **1.2 GB free**. A branch asleep for 57 minutes woke and answered **HTTP 200 in 636 ms**. Five more cold branches woke in 3.3 to 5.5 s, the extra time being first certificate issuance for that hostname rather than the runtime. After waking six branches, still 1213 MB free.

**The install path, on a clean box.** The installer brought up Docker, found ext4 cannot reflink and built itself an XFS volume that can, derived the sslip.io domain, obtained real certificates and printed a working setup URL. From a laptop: the CLI logged in over HTTPS, deployed an app reachable at its own hostname, `psql` connected through the SNI lane on 5432, a branch forked in 1.3 s carrying data and leaking nothing back, services slept to `exited`, and a manual stop held against traffic. Re-running the installer upgraded in place without touching state, and a hard reboot brought the loop mount, the stack and every service back unattended.

## What the real environments broke

The branch did not work when first assembled. Roughly twenty defects were found and fixed, almost all of them by running the thing rather than by reading it. The ones worth knowing:

- **No app could reach its own database on any fresh Linux box.** The daemon decides whether it can bind the Docker bridge gateway using Node's interface list, which omits an interface that is up with no carrier. The bridge has no carrier until the first container attaches, and the daemon starts before any branch exists, so the answer was always no, permanently, behind one warning line.
- **Memory-pressure eviction read the host, not the cgroup.** The daemon ships in a container. Measured inside a 512 MiB limit it believed it had 8 GiB, so under real pressure it would evict nothing and let the kernel kill a branch instead. The eviction promise, silently inverted.
- **Every `insta` command 404'd from an agent shell.** The CLI enrols itself as an agent and calls `POST /agent/sessions` before its first authenticated request. The daemon had no such route, so the entire CLI surface failed for exactly the audience this runtime targets.
- **The installer's only documented escape hatch was broken.** Compose lets the calling shell outrank `--env-file`, so running a self-built image rendered `repo:tag:tag`.
- **Every bucket reported stopped on a live install**, because the services view read the S3 hostname as if it were a container name.
- **A deploy could collide its own host port with the database lane** and fail outright.
- **Five security issues** a reviewer would have caught: credentials in a failed command's error text, credential files written world-readable, a rate limiter walkable by spoofing a forwarded header, an unvalidated TLS server name reaching a filesystem path and certificate issuance, and unbounded DNS lookups in the domain routes.

## Closed since the first draft

1. **arm64 templates.** Measured rather than assumed: all seven canonical images were amd64-only, and one template pinned the amd64 child of an upstream index rather than the index. `meta.architectures` is now a mandatory manifest field that drives the build platforms, verifies what was pushed, feeds the catalog, greys out the dashboard, and refuses a deploy this box cannot run. Every version bumped, since the old tags are immutable. The workflow itself has not run yet.
2. **`POST /agent/sessions`** implemented in both run modes, with the cloud's response shape.
3. **The three container suites** the integration order names: fork variants including the strict mode that must refuse rather than silently copy, the data directory migration, and the router lanes with a real psql client through SNI. Green on macOS and Linux.
4. **`COMPATIBILITY.md`** rows corrected, along with a lost-password recipe that could not work and two pages recommending a CLI command that does not exist.

## What is left for you

1. **Publish the image and cut a tag.** This is the blocker. `ghcr.io/insforge/instacloud` has never been published and `get.instacloud.com` does not resolve, so a stranger following the README today gets a registry denial from both the one-liner and its fallback. Everything else in this branch works; this is release plumbing and it is yours to do.
2. **Governance.** The code ships twelve gated actions and an Approvals page, the README headlines it, and the docs site removed it. Still contradictory, still your call.
3. **Sign-off** on the URL shape as implemented and the idle defaults: 5 minutes for compute, 10 for databases, a 15 percent RAM floor.

Worth knowing before you run this publicly: on a box with an auto domain, certificate transparency publishes every hostname within minutes and scanners then hit them, which counts as traffic and wakes services. An operator watching `docker ps` will think scale-to-zero is broken. A control service that never got a public certificate slept on schedule twice while published names kept waking. This is documented in the sleep page.

Not in scope, per the spec: `insta migrate`, which lives in the CLI repo, and scheduled backups.

## How it was built

`plans/impl/` carries the whole record: the integration contract, eight package plans, the merge ladder, the verifier findings and the workflow scripts. Eight packages were built in parallel against that contract, merged in order, attacked by independent reviewers, then taken to two real VPS boxes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
