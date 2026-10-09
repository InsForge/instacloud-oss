# 06 WP6: packaging and install (image, compose stack, edge, installer, release workflow)

Contract: `00-contract.md` sections 2 (decisions 2, 21, 22, 23, 44, 46), 11, 12, 15. Design source: `designs/wp6.json`, adjusted to those decisions (no coreutils requirement, `INSTA_OSS_*` stack keys, `/tls/ask` served by WP2's `src/router/internal.ts`, `ownsHostname` from WP2). Merge position: after WP2.

## Scope

- Multi-arch OCI image `ghcr.io/insforge/instacloud:<version>`: Node 22 bookworm-slim, docker CLI copied from `docker:<v>-cli`, built `ui/dist`, `templates/`, run with `tsx`.
- Three-service compose stack: `io-instad` (host network, docker socket, data dir bind-mounted at the identical path), `io-edge` (Caddy 2, host network, on-demand TLS gated by the daemon's loopback ask endpoint, ACME with internal fallback or internal only), `io-garage` (compose-managed Garage on bind dirs, ports 127.0.0.1:3900 and :3902).
- POSIX `install.sh` that is also the upgrader: preconditions, Docker install, `/var/lib/instacloud` with a reflink probe and an XFS `reflink=1` loop image fallback, public IP to `<ip-dashes>.sslip.io`, writes `/etc/instacloud/{instad.env,compose.yml,Caddyfile}` and the Garage toml, `compose up`, waits on `/healthz`, prints the setup URL; `--print-env|--print-compose|--print-caddyfile` render without side effects.
- Tag-triggered release workflow (linux/amd64 + arm64); CI additions (`shellcheck`, no-push `docker build`).

No API route. No new dependency (`tsx` moves to `dependencies`).

## Files

Owned: `Dockerfile`, `.dockerignore`, `install.sh`, `.github/workflows/release-image.yml`, `test/install.test.ts`, `test/image.int.test.ts`, `test/compose.int.test.ts`, `package.json` (`start`, `build:image` scripts; `tsx` to dependencies; `version` = release source of truth).

Shared: `.github/workflows/ci.yml` (append two steps), `src/main.ts` region WP6 (server-mode banner with `cfg.version`), `src/adapters/garage.ts` server-mode `ensure()` branch (WP5 writes the rewrite; WP6 verifies the compose-managed path against a real stack and adjusts only the error text).

## Algorithm

### A. Dockerfile

```
# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS ui
WORKDIR /app/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
FROM docker:28-cli AS dockercli
FROM ${NODE_IMAGE}
ARG VERSION=dev
ENV NODE_ENV=production INSTA_OSS_MODE=server INSTA_OSS_VERSION=${VERSION} INSTA_OSS_TEMPLATES_DIR=/app/templates INSTA_OSS_UI_DIST=/app/ui/dist
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY templates ./templates
COPY --from=ui /app/ui/dist ./ui/dist
LABEL org.opencontainers.image.source=https://github.com/InsForge/insta-oss org.opencontainers.image.version=${VERSION}
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.INSTA_OSS_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node","node_modules/tsx/dist/cli.mjs","src/main.ts"]
```

Pins (`node:22.x`, `docker:28.x-cli`, `caddy:2.x`) are fixed at implementation to exact existing multi-arch tags. `tsx` at runtime because `tsconfig` uses bundler resolution with extensionless imports and it is already the `bin` runtime. Root inside the container (it owns the Docker socket). `.dockerignore`: `node_modules`, `ui/node_modules`, `ui/dist`, `templates/node_modules`, `templates/package-lock.json`, `templates/scripts/*.test.mjs`, `.git`, `.github`, `.claude`, `docs`, `plans`, `assets`, `test`, `e2e`, `*.md` except `templates/**/README.md`.

### B. Compose (`/etc/instacloud/compose.yml`, written verbatim by install.sh; operator overrides in `compose.override.yml`)

```
name: instacloud
services:
  instad:
    image: ${INSTA_OSS_IMAGE}:${INSTA_OSS_VERSION}
    container_name: io-instad
    restart: unless-stopped
    network_mode: host
    init: true
    stop_grace_period: 30s
    env_file: instad.env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${INSTA_OSS_DATA_DIR}:${INSTA_OSS_DATA_DIR}
  edge:
    image: caddy:2
    container_name: io-edge
    restart: unless-stopped
    network_mode: host
    depends_on: [instad]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ${INSTA_OSS_DATA_DIR}/caddy/data:/data
      - ${INSTA_OSS_DATA_DIR}/caddy/config:/config
  garage:
    image: dxflrs/garage:v2.3.0
    container_name: io-garage
    restart: unless-stopped
    ports:
      - 127.0.0.1:3900:3900
      - 127.0.0.1:3902:3902
    volumes:
      - ${INSTA_OSS_DATA_DIR}/garage/garage.toml:/etc/garage.toml:ro
      - ${INSTA_OSS_DATA_DIR}/garage/meta:/var/lib/garage/meta
      - ${INSTA_OSS_DATA_DIR}/garage/data:/var/lib/garage/data
```

Garage stays on the compose bridge (the daemon `docker network connect`s it to branch networks for rclone).

### C. Caddyfile (concrete values rendered by install.sh from `instad.env`; no runtime placeholders: `8081` is `INSTA_OSS_INTERNAL_PORT` and `8080` is `INSTA_OSS_PORT`, both at their defaults below)

```
{
	admin off
	email <INSTA_OSS_ACME_EMAIL>            # line omitted when empty
	on_demand_tls {
		ask http://127.0.0.1:8081/tls/ask
	}
}
https:// {
	tls {
		on_demand
		issuer acme                          # omitted when INSTA_OSS_TLS=internal
		issuer internal
	}
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080 {
		header_up X-Forwarded-Proto https
		header_up X-Forwarded-Host {host}
		flush_interval -1
	}
}
http:// {
	redir https://{host}{uri} permanent
}
```

With `INSTA_OSS_TLS=internal` the installer copies Caddy's root (`<dataDir>/caddy/data/caddy/pki/authorities/local/root.crt`, present after the first HTTPS request; the installer triggers one with `curl -k https://api.<domain>/healthz`) to `<dataDir>/edge/ca.pem` and writes `INSTA_OSS_CA_FILE` into `instad.env`.

### D. Garage toml (written once; `root_domain` lines patched on `--domain` change)

`metadata_dir`, `data_dir`, `db_engine = "sqlite"`, `replication_factor = 1`, `rpc_bind_addr = "[::]:3901"`, `rpc_secret` (64 hex, generated once), `[s3_api] s3_region = "garage"`, `api_bind_addr = "[::]:3900"`, `root_domain = ".s3.<domain>"`, `[s3_web] bind_addr = "[::]:3902"`, `root_domain = ".s3.<domain>"`, `index = "index.html"`.

### E. install.sh (POSIX sh, `set -eu`)

0. Constants `CFG=/etc/instacloud`, `DATA=/var/lib/instacloud`, `IMG=/var/lib/instacloud.img`, `ENV=$CFG/instad.env`, `IMAGE=ghcr.io/insforge/instacloud`, `REPO=InsForge/insta-oss`. Flags `--domain`, `--email`, `--version`, `--tls acme|internal`, `--data-img-gib`, `--data-dir` (required to CHANGE an existing data dir), `--print-env|--print-compose|--print-caddyfile|--print-daemon-json|--print-firewall`, `-y`. Env equivalents `INSTA_OSS_DOMAIN`, `INSTA_OSS_ACME_EMAIL`, `INSTA_OSS_VERSION`, `INSTA_OSS_TLS`, `INSTA_OSS_IMAGE`, `INSTA_OSS_DATA_IMG_GIB`, `INSTA_OSS_PUBLIC_IP`, and pass-through of every `INSTA_OSS_*` present in the environment into `instad.env`. Flag > env > existing `instad.env` value > default.
1. `--print-*` renders and exits without root or side effects.
2. Preconditions: root, Linux, `x86_64|aarch64`, `curl`, `ss`; `UPGRADE=1` when `$ENV` exists.
3. Ports: when the stack is not up, refuse if 80, 443 or 5432 are bound (print the holder); warn for 6379, 3306, 27017.
3b. Firewall (apps reach the router at the docker bridge gateway through `--add-host ...:host-gateway`, and that traffic traverses the host INPUT chain; a default-deny ufw, common on provider images, silently drops every in-container DATABASE_URL, S3 and API call while the same URLs work from outside): if `ufw status` reports `active`: `ufw allow in on docker0 to any port 443,5432,6379,27017 proto tcp`, `ufw allow in on docker0 to any port 20000:20999 proto tcp`, and inbound `ufw allow 80,443,5432/tcp` (the setup URL and public database lane are unreachable otherwise); idempotent (ufw de-duplicates), each rule printed. If `firewall-cmd --state` is `running`: the same ports in the `docker` zone (`--permanent` + `--reload`). Neither present -> print nothing. `--print-firewall` renders the rules without applying them.
4. Docker: `curl -fsSL https://get.docker.com | sh` when missing; enable; require `docker compose version`. Address pools: every branch is one user-defined network and stock dockerd yields only 31 (`172.17-31.0.0/16` minus docker0 plus 16 x /20 under `192.168.0.0/16`), so the 32nd branch fails with `could not find an available, non-overlapping IPv4 address pool`. On a fresh Docker install, or when `/etc/docker/daemon.json` is absent or lacks the key, write `{"default-address-pools":[{"base":"10.100.0.0/14","size":24}]}` (1024 /24 branch networks; merged into an existing file with the Node-free `sed`/heredoc path or, when the file has other keys, printed as an instruction) and `systemctl restart docker` BEFORE compose up; when the key is already set, leave it and print a warning naming the current pools. `--print-daemon-json` renders the file.
5. Data dir and reflinks: `mkdir -p $DATA`; mount `$IMG` if present and not mounted; probe with a Node one-liner is unavailable, so use `cp --reflink=always` on two temp files (GNU cp exists on every supported distro host); success -> native. Failure with non-empty `$DATA` and no image -> print the basebackup warning and continue. Failure with empty `$DATA` -> `xfsprogs`, `df` free check (>= 15 GiB), `SIZE = INSTA_OSS_DATA_IMG_GIB || free - 5` (min 10), `truncate -s ${SIZE}G $IMG`, `mkfs.xfs -q -m reflink=1`, fstab `$IMG $DATA xfs loop,nofail,x-systemd.required-by=docker.service,x-systemd.before=docker.service 0 0` (docker.service must not start while the data mount is absent: dockerd's `--restart unless-stopped` would otherwise bring every Postgres up before instad and, with a `-v` bind, on an empty directory; the `--mount type=bind` in WP4 is the second belt, decision 56), `mount`, re-probe. Then `mkdir -p $DATA/{pg,vol,md,garage/meta,garage/data,caddy/data,caddy/config,edge}`; `chmod 700 $DATA`.
6. Domain: flag/env/existing/auto; auto = public IPv4 (`INSTA_OSS_PUBLIC_IP` | ipify | ifconfig.me | `ip route get 1.1.1.1` src) -> `<a-b-c-d>.sslip.io`; a private IP warns that certificates fall back to the internal issuer.
7. Secrets and files: `INSTA_OSS_SECRET` (existing or 64 hex), Garage `rpc_secret`; write the toml if absent (patch `root_domain` on domain change); resolve `INSTA_OSS_VERSION` (flag | env | GitHub releases latest | `latest`); write `$ENV` (fresh: the full block from contract section 15 with server defaults; upgrade: keep existing lines, append missing keys, always set version/domain/tls/email), `chmod 600`; write `compose.yml` and `Caddyfile` (always overwritten). Refuse a changed `INSTA_OSS_DATA_DIR` on upgrade without `--data-dir`.
8. Up: `cd $CFG && docker compose --env-file instad.env pull && docker compose --env-file instad.env up -d --remove-orphans`.
9. Readiness: poll `http://127.0.0.1:8080/healthz` every 2 s up to 60 s; on timeout print `docker compose logs instad` tail and exit 1. With `--tls internal`, `curl -k https://api.<domain>/healthz` once and copy the root CA to `$DATA/edge/ca.pem`.
10. Print exactly:
```
InstaCloud is running.
  Setup:    https://console.<DOMAIN>/setup
  API:      https://api.<DOMAIN>
  CLI:      insta login --api-key <token from the setup page> --api-url https://api.<DOMAIN>
  Config /etc/instacloud   Data /var/lib/instacloud   Reflinks: native|loop image (<SIZE> GiB)|unavailable
Re-run this script to upgrade (add --version vX.Y.Z to pin).
```

Upgrade = re-run (ports check skipped while the stack is up; step 5 only mounts; step 7 merges; step 8 recreates only changed services; branch containers are not compose members and keep running). Rollback = re-run with the previous `--version`.

### F. Release

`npm version x.y.z` tags `vx.y.z`; the workflow on `v*` tags (and `workflow_dispatch` with an existing tag) checks `tag == v<package.json version>`, builds `linux/amd64,linux/arm64` with buildx, pushes `:x.y.z`, `:x.y`, `:latest` (non-prerelease), `:sha-<sha>`, `build-args VERSION=<tag>`, GHA cache. `install.sh` resolves the newest GitHub release, so publishing the release makes the upgrade visible.

### G. get.instacloud.com

CloudFront distribution over `raw.githubusercontent.com/InsForge/insta-oss/main/install.sh` (same pattern as `agents.instacloud.com`); action item, not code in this repo. The raw URL is the documented fallback.

## Tests

`test/install.test.ts` (no Docker):
- `sh -n install.sh exits 0`
- `--print-env with INSTA_OSS_DOMAIN=example.test INSTA_OSS_SECRET=deadbeef contains every key in CONFIG_KEYS from src/config.ts plus INSTA_OSS_IMAGE, INSTA_OSS_VERSION, INSTA_OSS_TLS, INSTA_OSS_ACME_EMAIL`
- `--print-compose contains network_mode: host, the docker.sock bind, ${INSTA_OSS_DATA_DIR}:${INSTA_OSS_DATA_DIR}, container_name io-instad/io-edge/io-garage, init: true, stop_grace_period: 30s, and no ports: on instad`
- `--print-caddyfile with INSTA_OSS_TLS=acme has ask http://127.0.0.1:8081/tls/ask, on_demand, issuer acme then issuer internal; with INSTA_OSS_TLS=internal has no issuer acme`
- `INSTA_OSS_PUBLIC_IP=203.0.113.7 --print-env yields INSTA_OSS_DOMAIN=203-0-113-7.sslip.io`
- `pass-through: INSTA_OSS_IDLE_COMPUTE_SEC=15 in the environment lands in --print-env`
- `the fstab line the script writes (grep the heredoc) is "$IMG $DATA xfs loop,nofail,x-systemd.required-by=docker.service,x-systemd.before=docker.service 0 0"`
- `--print-daemon-json renders {"default-address-pools":[{"base":"10.100.0.0/14","size":24}]}; the script greps daemon.json for default-address-pools before writing`
- `--print-firewall lists ufw allow in on docker0 ... 443,5432,6379,27017 and 20000:20999 and the inbound 80,443,5432 rule; the script gates them on ufw status / firewall-cmd --state`

`GET /tls/ask in local mode is not a route (SPA fallback or 404, never 200)`: WP2 owns and ships this assertion (02 tests, `test/router.test.ts` internal listener case, plus `/tls` in `API_PREFIXES` so Fastify answers 404 JSON); WP6 has no edit right on `test/server.test.ts` (contract 1.2) and files an issue against WP2 if the assertion is missing.

`test/image.int.test.ts` (integrator only, container `io-imagetest`): `docker build --build-arg VERSION=test -t instacloud:test .`; run in local mode with the socket and a tmp data dir on port 18080; `/healthz` ok; `docker exec io-imagetest docker version` succeeds; `ls /app/ui/dist/index.html /app/templates/hermes/insta.template.yaml`; `GET /` serves the SPA shell with `window.__INSTA_OSS__`.

`test/compose.int.test.ts` (integrator only): render env/compose/Caddyfile into a tmp dir; `docker compose --env-file instad.env -f compose.yml config` exits 0 and shows host networking and the two binds on instad; never `up`.

CI: `shellcheck -s sh install.sh`; `docker build --build-arg VERSION=ci -t instacloud:ci .` (no push).

## Done when

- [ ] All suites above green; `npm run typecheck && npm run lint` green; `npm start` runs the daemon.
- [ ] On a fresh Ubuntu 22.04 VM with a public IP: `sh install.sh` prints the two lines; `https://console.<ip>.sslip.io/setup` loads with a valid certificate; `https://api.<ip>.sslip.io/me` answers 401; re-running the script is a no-op upgrade; `truncate -s +20G` + `xfs_growfs` grows the loop image.
- [ ] `sh install.sh --tls internal` on a runner produces `<dataDir>/edge/ca.pem` and `curl --cacert` works (the e2e depends on it).
- [ ] Image on both architectures boots to `/healthz`.
- [ ] Docs facts handed to WP8.

## Docs facts for WP8

- One-liner `curl -fsSL https://get.instacloud.com | sh` (fallback: the raw GitHub URL); requirements root, Ubuntu 22.04+/Debian 12+, amd64/arm64, 2 vCPU, 2 GiB, 15 GiB free, ports 80/443/5432 free; Docker installed if missing.
- Writes `/etc/instacloud/{instad.env,compose.yml,Caddyfile}`, data under `/var/lib/instacloud`, `/var/lib/instacloud.img` when a loop image was needed (fstab line with `nofail,x-systemd.required-by=docker.service,x-systemd.before=docker.service`, so Docker waits for the data mount); `chmod 600 instad.env`.
- Docker address pools: the installer writes `/etc/docker/daemon.json` `default-address-pools` (`10.100.0.0/14`, /24 per branch network, 1024 networks) on a fresh install and restarts Docker; a box that already sets the key keeps it and the docs explain the 31-network default and the 507 `docker has no free network subnets` answer.
- Firewall: with ufw or firewalld active the installer opens 80/443/5432 inbound and docker0 -> host 443, 5432, 6379, 27017, 20000-20999 (`--print-firewall` shows the rules); a custom firewall must replicate them or apps cannot reach their own databases.
- Options: `--domain`, `--email`, `--version`, `--tls acme|internal`, `--data-img-gib`; env `INSTA_OSS_*` pass-through.
- Upgrade = re-run; rollback = re-run with `--version`; `docker compose down` in `/etc/instacloud` stops the stack; branch containers keep running across a stack recreate.
- Security posture: the daemon container mounts the Docker socket (root on the box); treat the admin password and every `insta_` token as root credentials.
- Reflinks: check with `xfs_info /var/lib/instacloud | grep reflink=1`; growing the image: `truncate -s +20G /var/lib/instacloud.img && losetup -c <dev> && xfs_growfs /var/lib/instacloud`. `Reflinks: unavailable` is not an install failure: the daemon boots, logs one warning and streams `pg_basebackup` for branch forks (contract decision 23); only `INSTA_OSS_FORK=reflink` in `instad.env` makes it refuse to start on such a box.
- The auto domain shares certificate rate limits with everyone on sslip.io; production wants a real domain (`--domain`, wildcard or per-host A records to the box).
- `INSTA_OSS_TLS=internal` for air-gapped or CI boxes; the CA lives at `/var/lib/instacloud/edge/ca.pem` for `curl --cacert`, `PGSSLROOTCERT`, `NODE_EXTRA_CA_CERTS`.
- Compose container names `io-instad`, `io-edge`, `io-garage`.
