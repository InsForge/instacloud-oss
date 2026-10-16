# End-to-end scripts

Two shell scripts that drive a real daemon with the real CLI over real Docker. They are the
public-surface tests: everything they touch is something a user types.

| Script | Mode | Where it is safe to run |
| --- | --- | --- |
| `local-smoke.sh` | local | your laptop or a CI runner, from the repository root |
| `server-smoke.sh` | server | a throwaway VM only, as root; it installs a stack on the box |

```sh
sh e2e/local-smoke.sh
sudo -E sh e2e/server-smoke.sh
```

`lib.sh` holds the shared helpers. Both scripts source it and neither uses bashisms, so they run
under `dash`.

## Isolation

The scripts create containers named `io-<project>-<branch>-*`, so they collide with the Docker
vitest suites (`*.int.test.ts`) and with each other. Run one Docker workload at a time. In CI the
two jobs run on separate VMs, and `E2E_RUN_ID` keeps the project names apart.

Both scripts delete their project on the way out, including on failure, and then assert that no
container, network or data directory survived.

Neither writes into the checkout. `insta project create` links the directory it runs in, writing
`.insta/` and appending to `.gitignore`, so both scripts run every CLI call from a scratch
directory outside the repository and put their daemon or install log there too. A run that fails
half way leaves the repository as clean as one that passes.

## Inputs

Local: `INSTA_OSS_PORT`, `E2E_RUN_ID`, `E2E_START_DAEMON`, `E2E_IMAGE`, `E2E_LOG`.
Server: `E2E_RUN_ID`, `INSTA_OSS_IMAGE`, `INSTA_OSS_DOMAIN`, `INSTA_OSS_TLS`, `E2E_UNINSTALL`,
`E2E_INSTALL_LOG`.

Both shorten the idle windows (`INSTA_OSS_IDLE_COMPUTE_SEC=15`, `INSTA_OSS_IDLE_DB_SEC=20`,
`INSTA_OSS_SWEEP_SEC=2`, `INSTA_OSS_CREATE_GRACE_SEC=0`) so the sleep step takes seconds, and set
`INSTA_OSS_RAM_FLOOR_PCT=0` so memory-pressure eviction does not stop the containers under test on
a small runner.

## Hard and soft assertions

Hard, so a failure fails the run: container states, URL shapes, the Postgres and S3 round trips,
branch isolation, the volume fork marker, a project starting empty, the teardown sweep. On the
server job also the XFS reflink mount, 401 without a token, sign-up refused twice, an `insta_`
token minted, `--api-key` login, the https URL shape, psql over the public 5432 lane, the reflink
fork method and timing, and upgrade idempotence.

Soft, printed as `skip`: branch timing on a filesystem without reflinks, the naming of a second
template deployment, and anything that depends on a CLI or template release that is not out yet.

## Not covered here

- ACME issuance, which needs a public name and a public IP. The server job uses the internal
  issuer.
- The automatic sslip.io domain against a real public address.
- Custom-domain DNS and certificate issuance. Step 8 exercises the routes and the printed
  records, not a real delegation.
- Real memory pressure. Eviction is covered by `test/scheduler.test.ts` through
  `INSTA_OSS_MEM_BUDGET_MB`.
- `insta postgres connect`, which is interactive.
- arm64. Both jobs run on amd64 runners.
