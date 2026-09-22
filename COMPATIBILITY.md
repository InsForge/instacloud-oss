# CLI and MCP compatibility

Command-by-command behavior of InstaCloud OSS against the standard insta surface.

InstaCloud OSS implements the standard `insta` command surface: no daemon-only commands. This page is
the command-by-command result of running every registered CLI command and every insta-mcp tool
against the daemon. Cloud-only concepts return `501` with guidance rather than pretending to work.

Two rows differ by run mode. **Server mode** is a box installed with `install.sh`: a domain, one
admin account, `insta_` tokens. **Local mode** is `npm run dev` on your laptop: no auth, no
domain. See [self-hosting](https://docs.instacloud.com/self-hosting/overview).

## CLI commands

| Command | InstaCloud OSS behavior |
| --- | --- |
| `status` | server: the admin email; local: `user: local` |
| `login` / `logout` | server: `insta login --device --api-url https://api.<domain>` (a short code the admin approves at `https://console.<domain>/device`, the recommended flow), `insta login --api-key insta_... --api-url https://api.<domain>` for headless/CI, and `--email` with the admin password; bare `insta login` and `--oauth` are `501` (hosted-identity flows are cloud-only). local: not needed, the daemon trusts loopback |
| `org list` | builtin single org (`local`) |
| `project create/link/list/delete` | a new project provisions nothing and reports `resources: []`; add what you need with `services add`. `delete` is govern-gated and returns the cloud teardown summary (`destroyed` and `failed` counts), with **409** instead of 200 when any branch's teardown failed: those branches keep their rows and so does the project, because a branch row must never point at a project that is gone |
| `services list` | rows carry `domain`, `endpoint`, `always_on`, `image`, `port` and a `runtime` of `online`, `asleep`, `suspended`, `stopped` or `none` |
| `services add postgres\|storage\|redis\|mysql\|mongodb\|compute <name>` | several of each type per branch, up to `INSTA_OSS_MAX_SERVICES_PER_TYPE` (default 5). Every postgres gets its own container and data directory, every storage its own bucket. Postgres, storage and managed databases are created on ONE branch, the one named or the default, exactly as they are in the cloud, and a new branch carries what its source carried. A compute group is the one divergence: it is a registration with no resources until a deploy puts a container on a branch, so it is project-wide and appears in every branch's list with a `runtime` of `none` until you deploy to that branch. `add compute` takes `--always-on`, `--port`, `--image` and `--volume` |
| `services remove` / `rename` | every type, including postgres and storage. `remove` acts on ONE branch, the one named or the default, exactly as `add` does: it destroys that branch's container, bucket and bytes, leaves every other branch's copy alone, and unregisters the name only once the last branch carrying it is gone. A compute group is removed from one branch too: its container and the bytes of its `/data` volume are per branch, so `remove` takes that branch's container and volume and leaves every other branch's alone. Only the registration is project-wide, and it retires with the last branch still running the group. The response is the teardown summary counting what actually went, with **409** instead of 200 when anything failed: nothing is deleted for a container that could not be proven gone, so the service keeps its row and its data and the removal can be retried |
| `services secrets` / `set-access storage` | per-service secret names; bucket public-read or private (gated `service.setAccess`) |
| `secrets` / `secrets list` / `secrets tree` | full bundle (gated) plus the names-only project, branch and service binding tree. Every service carries suffixed names (`DATABASE_URL_ANALYTICS`, `BUCKET_NAME_ASSETS`, `REDIS_URL_CACHE`) and the OLDEST service of each type also holds the unsuffixed keys (`DATABASE_URL`, the `AWS_*` and `BUCKET_NAME` bundle, `REDIS_URL`); remove the oldest and the unsuffixed keys move to the next one. Every DSN is host-facing: the same string the daemon hands a container, with the address a client outside the branch network dials |
| `secrets set/unset NAME [--branch] [--service]` | project-wide, branch override, or service-bound; reserved names rejected (gated `secrets.write`) |
| `secrets bind` / `unbind` / `bindings` / `sources` | `501`: aliasing a credential onto an env name of your choosing is not built yet. Every service credential already reaches every compute container in the branch, under its suffixed name and, for the oldest service of each type, the unsuffixed one, so bind the value by reading that name or set your own with `secrets set` |
| `branch create/switch/delete/list` | `create` forks the disk: a reflink copy of the Postgres data directory and of every compute volume, plus an object copy of the bucket. The reflink copy needs a source at rest, so a RUNNING database is streamed with `pg_basebackup` instead, as is any database on a filesystem without reflinks. Apps are redeployed asleep. A compute volume is copied whether or not its app is running, which a database is not: there is no consistent streaming copy of an arbitrary application's files, so a live volume is walked file by file, each one as it stood when the walk reached it, rather than failing the create. That is many moments of the tree and not the single instant a crash freezes, so stop the group first if your data's consistency spans files. `delete` returns the teardown summary, and answers **409** rather than 200 when that summary reports failures: the row is kept, marked `cleanup-failed`, so the resources it names stay reachable and `branch delete` can retry the demolition, and a 200 would tell a client the branch is gone when it is not. A `cleanup-failed` branch is refused as a fork source and as a deploy target until its teardown finishes. A delete of the DEFAULT branch answers 409, not 404: the branch exists, and a 404 would send you looking for it. A successful delete also drops that branch's branch-scoped secrets, so a new branch of the same name does not inherit them; a failed one keeps them, because the retry still needs them. `create` and rename hold the name to the documented rule: lower-kebab (`a-z`, `0-9`, `-`), no leading or trailing hyphen, 1 to 39 characters, because the name becomes a DNS label in every hostname that addresses the environment. A name that breaks it answers **400**, not the 409 this route otherwise falls back to: nothing about the state would make it work, so it is the request that is bad. A non-string `name` is the same 400. `create` also takes the console's `excludeServices` (boolean, else **400**): the branch is cut empty, with no service, secret or secret binding copied from the parent, though project-scoped compute registrations still list as not-deployed rows. Listing the branches of a project that does not exist answers **404**, not an empty 200, so a client holding a stale project id learns the project is gone instead of rendering an environment list with nothing in it |
| `branch merge <source>` | structural and additive: compute groups missing on the target materialize against its own database and bucket; data never merges (gated `service.add`) |
| `deploy` | image mode is gated and works from anywhere. Source mode (`insta deploy ./dir`) builds the image with the local Docker, so it needs the CLI on the box that has your code; from a laptop against a remote install use `--image` or a template |
| `compute start/stop/suspend/status` | `stop` is a durable intent and traffic never wakes a stopped service; `start` clears it; `suspend` pauses. `status` distinguishes `running`, `suspended` (asleep or paused), `stopped` and `none`; a sleeping row reads `asleep` in `insta services list`. A stop or suspend the runtime REFUSES answers **409** rather than 200: nothing is recorded, the service keeps the state it had, and the verb can be retried. The same applies to a redeploy that cannot put the replacement back into a standing stopped or suspended state, which answers 409 naming the verb to run, because the image did go out. `start` waits for its wake rather than timing out: it holds the service's operation lock while the wake runs, and releasing the caller on a timer would leave that wake starting a container with nothing holding the lock. The wake bound (`INSTA_OSS_WAKE_TIMEOUT_SEC`, 60s) is for a request held at a lane, which is what it was written for |
| `compute limits <group> --memory --cpu` | implemented, on the cloud grid and cap (8 vCPU, 8192 MiB) |
| `compute always-on on\|off <group>` | implemented. The default matches the cloud: compute on the default branch is always-on, and on every other branch it scales to zero. Managed Redis, MySQL and MongoDB follow the same rule, while Postgres scales to zero on every branch unless `postgres always-on on`. An explicit setting wins on every branch. `INSTA_OSS_ALWAYS_ON_DEFAULT=0` makes default-branch services scale to zero too; an upgrade keeps the value its `instad.env` already has |
| `domain attach <host> [--group] [--branch]` | binds your own hostname and prints the DNS record to create (a `CNAME` to `api.<domain>`); the certificate is issued on the first request. Local mode routes the alias but issues nothing. The CLI first asks the org for domains bought through InstaCloud, which answers an empty list here, so every name takes this bring-your-own path |
| `domain check <host>` | reports whether the record resolves and whether the host is being served. The envelope carries no `ssl` field in either mode. With `--tls custom` the certificate half of `configured` is answered by the supplied certificate itself, so a name it does not cover reads `pending`: nothing will issue one for it |
| `domain detach <host>` | unbinds it |
| `domain search/buy/list/status/records` | `501`: buying domains and managing their DNS records is cloud-only. The bought-domains list and the orders list answer empty lists instead, because `attach` and `detach` read them before taking the bring-your-own path |
| `postgres url [service] [--branch]` | server: the public DSN, `pg-<name>-<ref>.<domain>:5432` with `sslmode=require`, routed by SNI; local: `127.0.0.1:<port>`. A sleeping database wakes on connect. `--branch feat` returns feat's DSN |
| `postgres connect` | opens `psql` against that DSN |
| `postgres always-on on\|off` | implemented, per database service |
| `template list` / `template info <code>` / `template deploy <code\|dir\|url>` | the bundled catalog is served through the cloud template routes, so it works with no internet access. Registry code, local directory and GitHub URL all deploy. Image services only, and the usage stats are this daemon only. Two fields the cloud has no use for, because it picks the machine and you do not: every template carries `architectures`, and both catalog routes report this box's own as `hostArchitecture`. `deploy` refuses a template whose image is not published for this architecture, with a 400 before any service exists, rather than failing on the pull halfway through |
| `agent manifest` | per-branch postgres, storage and compute |
| policy get and set | implemented as routes (`GET /projects/:id/policy`, `PUT /projects/:id/policy/:action`) and in the dashboard. The CLI has no `policy` command of its own, on the cloud or here |
| `agent approvals list/approve/deny` | one-shot grants, same `202` flow. `--always`, which flips the project policy to allow, is a field on the approve route (`{"always": true}`) and a control in the dashboard; the CLI does not expose a flag for it |
| `agent events` | resource and governance timeline, agent ingest with dedup; the newest 5000 rows are kept. `limit` defaults to 50, clamps at 1000, and anything that is not an integer of 1 or more is a `400` |
| `metrics` / `logs` | docker-backed, cloud response shapes; targets `db`, `compute`, `redis`, `mysql`, `mongodb`, and `--group` selects among several databases. Metrics: the daemon samples `docker stats` every 30 s, keeps 7 days in `<data dir>/metrics-history.json`, and answers `from`/`to`/`step` with the cloud's series (`cpu_cores`, `memory_used_bytes`, `egress_bytes_rate`, `ingress_bytes_rate`); no disk series. Logs: a `docker logs` tail. `logs --deploy` is `501`, use `insta agent events` |
| `storage list/get/delete` | object listing (prefix and cursor paging), presigned GET download, single delete; gated `storage.read` and `storage.delete`. Presigned-POST upload and bulk delete serve the console file browser |
| `db query` (`POST /projects/:id/database/query`) | ONE ad-hoc SQL statement against the branch database, for the console's SQL editor and Data tab (several statements in one request answer `400` without executing anything). Row-shaped statements (SELECT/VALUES/TABLE, and a WITH whose top-level statement is a SELECT) answer `{columns, rows, rowCount, ms}` with every value as its exact TEXT (numerics never round through IEEE doubles), the first 5000 rows, under a 30 s statement timeout; anything else runs as written and answers psql's command tag. An empty result answers `columns: []` (column names come from the rows of the ONE execution). Gated `db.query` (default allow) and audited (`db.query` events, never the SQL text); a statement psql refused is a `400` quoting psql's first ERROR line; a sleeping instance is a `503` and is never woken by this route (wake it with `services wake` or the dashboard's gate) |
| redis key browser (`GET .../services/:sid/redis/keys`, `/redis/value`, `/redis/stats`) | one SCAN page per logical db (`db` 0-15, `cursor`, `count` up to 1000) plus the keyspace summary, one key's type/TTL/value (collections bounded at 200 entries), and the INFO counters picked into the console's Stats shape. Gated `db.read` (default allow); `503` while the instance sleeps; redis only, since mysql and mongodb have no browser yet |
| `regions` | the single `local` region (this machine) |
| `services scale` / `services upgrade` | `501`: machine scaling and instance specs are cloud pricing concepts |
| `compute repo` / `compute connect-repo` / `compute disconnect-repo` (and the console's Source tab) | The cloud's GitHub-App connect (`/github/*`, `source/deploy`) stays `501` (it needs a multi-tenant app). A server-mode box has its own public URL, so it ships a **native git push-to-deploy** on separate routes instead: `POST /projects/:id/services/:sid/git` binds a compute group to `owner/repo` (a Personal Access Token for a private repo, nothing for a public one) and returns a webhook URL + secret; add it to the repo (Settings > Webhooks, content type application/json) and a push to the tracked branch hits `POST /webhooks/git/<id>`, which the daemon HMAC-verifies and turns into `docker build <repo>` + a redeploy of that group. The build checks out the pushed commit SHA (not the mutable branch ref) and the redeploy reuses the group's existing port. A private repo's token is handed to BuildKit as the `GIT_AUTH_TOKEN` env-secret, never on docker's command line. Ordering is best-effort from the webhook payload (not a guarantee of git ancestry): the head commit's timestamp is used as the key but CLAMPED to the push's arrival time, so a future-dated or missing commit timestamp cannot appear "newest" and permanently block later pushes. A redelivery (same SHA) or a push whose clamped key is not newer than the current deployment is skipped with a `git.deploy.skipped` event. Each deploy reclaims the binding's superseded build images (keeping the one in use), and builds run under a hard timeout and a small daemon-wide concurrency cap, so an actively used box does not grow images without bound or fork-bomb itself on a burst of pushes. Push-to-deploy honours the project's **deploy** governance policy: it auto-deploys only when that policy is `allow`; under `approval_required` or `deny` the push is recorded as a `git.deploy.blocked` event and NOT deployed (a webhook cannot take part in an interactive approval, so deploy the commit manually or set the policy to `allow`). `GET`/`DELETE` on the same path show/remove the binding. The daemon builds the repo itself (BuildKit fetches the git context), so no remote build gateway is needed. `insta deploy ./dir` remains for a one-shot build from a local directory |
| `usage` / `billing` | `501`: metering is cloud-only by design. Local visibility is `manifest` plus docker-backed `metrics` and `logs` |
| `org create` | `501`: single-tenant |

## API tokens

Server mode mints bearer tokens for the CLI, MCP and agents. The CLI has no `tokens` command:
create one in the dashboard, on the Account page, or with `POST /tokens` and a session cookie.
`GET /tokens` lists them and `DELETE /tokens/:id` revokes one. In local mode those routes stay
`501`, because there is nothing to authenticate.

`scopes` is accepted on create and echoed back on the record, matching the hosted platform's wire
shape, and like the platform it is never enforced: every valid `insta_` key acts as the one admin
on every route. It is a label, not a permission boundary, so revoking a token is the only way to
withdraw its access. A create that supplies a non-empty `scopes` gets a `warning` field saying so,
which the hosted API does not send; a create without scopes returns the cloud's shape exactly.

## Agent sessions

The CLI enrols itself as an agent whenever it detects one around it (Claude Code, Codex, Cursor)
and mints a session at `POST /agent/sessions` before its first authenticated call, `insta login`
included. InstaCloud OSS answers that route in both run modes, so the CLI works from an agent shell.
The receipt is not a second credential: one box has one admin, the bearer already carries its full
access, and the daemon does not verify the signed assertion the CLI attaches to later requests.

## Backups

The backups API routes answer `501` with a hint that names the documented path, and there is
no `insta backup` command yet. Until the backups milestone: `pg_dump "$(insta postgres url)"` per
branch, a tar of `vol/` and the Garage directories under the data directory. See
[upgrade and backups](https://docs.instacloud.com/self-hosting/upgrade).

## MCP tools

The insta-mcp server (`insta_*` tools) is a thin client over the same endpoints. Point it at the
daemon (`PLATFORM_API_URL=https://api.<domain>` in server mode with an `insta_` bearer,
`http://127.0.0.1:8080` and any non-empty bearer in local mode) and it works:

| Tools | InstaCloud OSS behavior |
| --- | --- |
| `whoami · org_list · project_* · service_add/list/remove/access · deploy · compute_control/status · branch_* · storage_list/download_url/delete · manifest · secrets_* · metrics · logs · events · policy_get · approvals_*` | end to end, including the full governance flow (`202` then `approvals_approve` or `approvals_deny`) |
| `domain_*` | supported: the same add, check and remove behavior as the CLI verbs |
| `template_*` | supported where the MCP exposes them, over the same catalog routes |
| `org_create · usage · billing_summary/checkout/portal · service_scale/upgrade · deploy_events` | refused. The daemon answers `501` with its guidance, but insta-mcp maps every status at or above 500 to `platform_error` with the text `upstream error, retry`, so the sentence does not reach the agent and the refusal reads as transient. Ask the daemon directly, or the CLI, for the reason |
| `feedback` | bypasses the control plane entirely (posts to the hosted feedback service, tagged `target: oss`) |

## Branching vs merging

`branch` = a disposable isolated environment (a fork of the disk). `insta branch merge` is
**structural only**: it materializes missing services on the target; **data never merges back**.
Schema moves through version control: merge your code, run migration files against main,
redeploy, delete the branch environment.
