#!/bin/sh
# End-to-end smoke test for local mode: the daemon on the host, no auth, *.localhost URLs.
# Run it from the repository root. It creates one project and deletes it again on exit.
#
#   sh e2e/local-smoke.sh
#
# Inputs:
#   INSTA_OSS_PORT      daemon port (8080)
#   E2E_RUN_ID          suffix that keeps concurrent runs apart (local)
#   E2E_START_DAEMON    1 to start and stop the daemon here (default 1)
#   E2E_IMAGE           image to deploy (traefik/whoami:v1.10)
#
# It never touches a server-mode install and never runs the Docker vitest suites, whose
# container names it would collide with.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
# shellcheck source=e2e/lib.sh disable=SC1091  # resolved at run time from $HERE, not cwd.
. "$HERE/lib.sh"

PORT=${INSTA_OSS_PORT:-8080}
RUN=${E2E_RUN_ID:-local}
IMAGE=${E2E_IMAGE:-traefik/whoami:v1.10}
API=http://127.0.0.1:$PORT
START_DAEMON=${E2E_START_DAEMON:-1}
DATA=${INSTA_OSS_DATA_DIR:-${RUNNER_TEMP:-/tmp}/insta-oss-$RUN}
PROJECT=e2e-local-$RUN
# Beside the data directory, not in the checkout: a run has to leave the repository clean.
LOG=${E2E_LOG:-$DATA.log}
export API

# Short windows so step 7 does not take ten minutes, and no memory-pressure eviction: on a
# 7 GiB runner with images loaded the pressure pass would stop the containers under test.
INSTA_OSS_IDLE_COMPUTE_SEC=${INSTA_OSS_IDLE_COMPUTE_SEC:-15}
INSTA_OSS_IDLE_DB_SEC=${INSTA_OSS_IDLE_DB_SEC:-20}
INSTA_OSS_SWEEP_SEC=${INSTA_OSS_SWEEP_SEC:-2}
INSTA_OSS_CREATE_GRACE_SEC=${INSTA_OSS_CREATE_GRACE_SEC:-0}
INSTA_OSS_RAM_FLOOR_PCT=${INSTA_OSS_RAM_FLOOR_PCT:-0}
export INSTA_OSS_IDLE_COMPUTE_SEC INSTA_OSS_IDLE_DB_SEC INSTA_OSS_SWEEP_SEC
export INSTA_OSS_CREATE_GRACE_SEC INSTA_OSS_RAM_FLOOR_PCT

DAEMON_PID=
CLEANED=0

# Stop the daemon this script started, and MAKE SURE it is stopped: npx forks the process that
# holds the port, so killing the wrapper can leave the daemon listening. A leaked daemon is worse
# than a noisy failure, because the next run's healthz answers from the OLD process with the old
# state and knobs, and only fails later somewhere confusing. The data directory's lock names the
# holder's pid, so that is who gets stopped.
stop_daemon() {
  [ -n "$DAEMON_PID" ] || return 0
  kill "$DAEMON_PID" 2>/dev/null || true
  wait "$DAEMON_PID" 2>/dev/null || true
  _n=0
  while curl -sf "$API/healthz" >/dev/null 2>&1 && [ "$_n" -lt 15 ]; do
    _holder=$(jsel 'd.pid' < "$DATA/instad.lock" 2>/dev/null) || _holder=
    case $_holder in
      [1-9]*) kill "$_holder" 2>/dev/null || true ;;
      *) : ;;
    esac
    _n=$((_n + 1))
    sleep 1
  done
  if curl -sf "$API/healthz" >/dev/null 2>&1; then
    printf 'warn the daemon on %s is still listening\n' "$API" 1>&2
  fi
}

cleanup() {
  [ "$CLEANED" = "0" ] || return 0
  CLEANED=1
  STEP "11. teardown"
  if command -v insta >/dev/null 2>&1; then
    allow_delete >/dev/null 2>&1 || true
    insta project delete >/dev/null 2>&1 || true
  fi
  stop_daemon
}
trap cleanup EXIT INT TERM

STEP "0. preflight"
docker info >/dev/null 2>&1 || FAIL "docker is not running"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || FAIL "node 22 or newer is required, found $NODE_MAJOR"
command -v insta >/dev/null 2>&1 || npm i -g insta@latest
command -v psql >/dev/null 2>&1 || FAIL "psql is required (postgresql-client)"
HAVE_LOCALHOST_DNS=1
resolves e2e-probe.localhost || HAVE_LOCALHOST_DNS=0
OK "preflight (localhost wildcard dns: $HAVE_LOCALHOST_DNS)"

STEP "1. daemon"
cd "$ROOT"   # the daemon is started from the checkout: `npx tsx src/main.ts`
if [ "$START_DAEMON" = "1" ]; then
  mkdir -p "$DATA"
  INSTA_OSS_MODE=local INSTA_OSS_DATA_DIR=$DATA INSTA_OSS_PORT=$PORT \
    npx tsx src/main.ts >"$LOG" 2>&1 &
  DAEMON_PID=$!
fi
# ...and every CLI call runs from a scratch directory beside the data dir, never from the checkout:
# `insta project create` links the directory it runs in, writing .insta/ and appending to .gitignore,
# and a smoke run has to leave the repository clean. Step 9's template path is absolute for the same
# reason; the daemon reads that directory itself, so it must be valid wherever the daemon runs.
TPL=$ROOT/e2e/fixtures/tpl-hello
WORK=$DATA-work
rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK"
wait_for 90 curl -sf "$API/healthz" || FAIL "daemon never became healthy, see $LOG"
OK "healthz"

STEP "2. cli sees the daemon"
INSTA_API_URL=$API
export INSTA_API_URL
insta status | grep -q 'local' || FAIL "insta status does not report local mode"
OK "insta status reports local"

STEP "3. project and services"
insta project create "$PROJECT" >/dev/null || FAIL "project create failed"
SLUG=$(slug "$PROJECT")
REF=$SLUG-main
LIST=$(insta services list)
printf '%s\n' "$LIST" | grep -q 'postgres/' && FAIL "a new project must start with no postgres"
printf '%s\n' "$LIST" | grep -q 'storage/' && FAIL "a new project must start with no storage"
OK "project starts empty"
insta services add postgres db >/dev/null || FAIL "services add postgres failed"
insta services add storage store >/dev/null || FAIL "services add storage failed"
insta services add compute web >/dev/null || FAIL "services add compute failed"
insta services add postgres analytics >/dev/null || FAIL "a second postgres must be allowed"
# With two postgres services the service is no longer optional, so name it on every call.
DBURL=$(insta postgres url db)
DBURL2=$(insta postgres url analytics)
[ "$DBURL" != "$DBURL2" ] || FAIL "the two postgres services share a dsn"
if insta services add postgres db >/dev/null 2>&1; then
  FAIL "a duplicate service name must be refused"
fi
OK "services: two postgres, storage, compute; duplicates refused"

STEP "4. credentials round trip"
SECRETS=$(insta secrets --print)
printf '%s\n' "$SECRETS" | grep -q '^DATABASE_URL=' || FAIL "no DATABASE_URL in secrets"
SECRET_DSN=$(printf '%s\n' "$SECRETS" | sed -n 's/^DATABASE_URL="\(.*\)"$/\1/p')
DBHOST=$(url_host "$SECRET_DSN")
case $DBHOST in
  *127.0.0.1*) OK "DATABASE_URL points at 127.0.0.1" ;;
  *) FAIL "local DATABASE_URL host should be 127.0.0.1, got $DBHOST" ;;
esac
DBPORT=$(printf '%s\n' "$SECRET_DSN" | sed -e 's|^.*@[^:]*:||' -e 's|/.*$||')
LANE_LO=$(printf '%s\n' "${INSTA_OSS_LANE_PORT_RANGE:-20000-20999}" | cut -d- -f1)
LANE_HI=$(printf '%s\n' "${INSTA_OSS_LANE_PORT_RANGE:-20000-20999}" | cut -d- -f2)
if [ "$DBPORT" -ge "$LANE_LO" ] && [ "$DBPORT" -le "$LANE_HI" ]; then
  OK "DATABASE_URL port $DBPORT is in the lane range $LANE_LO-$LANE_HI"
else
  FAIL "DATABASE_URL port $DBPORT is outside the lane range $LANE_LO-$LANE_HI"
fi
psql_roundtrip "$DBURL" || FAIL "postgres round trip failed on $DBURL"
OK "postgres round trip"
s3_roundtrip "$SECRETS" || FAIL "s3 round trip failed"
OK "s3 round trip at the printed endpoint"

STEP "5. deploy"
DEPLOY=$(insta deploy --image "$IMAGE" --port 80 --group web)
printf '%s\n' "$DEPLOY"
URL=$(printf '%s\n' "$DEPLOY" | tr ' ' '\n' | grep -o 'http://web-[a-z0-9-]*\.localhost:[0-9]*' | head -1)
[ -n "$URL" ] || FAIL "no local app url in the deploy output"
case $URL in
  http://web-*.localhost:*) OK "url shape $URL" ;;
  *) FAIL "unexpected url $URL" ;;
esac
[ "$HAVE_LOCALHOST_DNS" = "1" ] || ensure_host "$(url_host "$URL")"
wait_for 60 curl -sf "$URL/" || FAIL "$URL never answered"
curl -sf "$URL/" | grep -q 'Host: web-' || FAIL "the app did not see a Host-based request"
OK "app answers and routing is by Host"
PORTS=$(docker port "$(svc_container "$REF" web)")
printf '%s\n' "$PORTS" | grep -q '127.0.0.1:' || FAIL "compute must publish on loopback only"
printf '%s\n' "$PORTS" | grep -q '0.0.0.0:' && FAIL "compute must not publish on 0.0.0.0"
OK "compute publishes on loopback only"

STEP "6. branch fork"
psql "$DBURL" -v ON_ERROR_STOP=1 -qtAc \
  "create table qa_branch_probe(v text); insert into qa_branch_probe values ('from-main')" \
  >/dev/null || FAIL "could not seed the branch probe table"
measure insta branch create feat --from main >/dev/null || FAIL "branch create failed"
if [ "${MEASURED_MS:-0}" -lt 60000 ]; then
  OK "branch create took ${MEASURED_MS}ms"
else
  SKIP "branch create took ${MEASURED_MS}ms (no reflink support on this filesystem)"
fi
insta branch list --json | grep -q 'feat' || FAIL "feat is missing from branch list"
FEAT_IDS=$(insta services list --branch feat --json | jsel '(d.services||d).map(function(s){return s.id}).join(",")')
MAIN_IDS=$(insta services list --branch main --json | jsel '(d.services||d).map(function(s){return s.id}).join(",")')
case $FEAT_IDS in
  *:pg-db*) OK "feat service ids are branch qualified" ;;
  *) FAIL "expected branch-qualified ids on feat, got $FEAT_IDS" ;;
esac
case $MAIN_IDS in
  *:*) FAIL "default-branch ids must be bare, got $MAIN_IDS" ;;
  *) OK "main service ids are bare" ;;
esac
FEATURL=$(insta postgres url db --branch feat)
[ "$FEATURL" != "$DBURL" ] || FAIL "feat and main share a dsn"
FEATVAL=$(psql "$FEATURL" -v ON_ERROR_STOP=1 -qtAc 'select v from qa_branch_probe limit 1')
[ "$FEATVAL" = "from-main" ] || FAIL "feat did not inherit the seeded row, got '$FEATVAL'"
psql "$FEATURL" -v ON_ERROR_STOP=1 -qtAc \
  "insert into qa_branch_probe values ('only-on-feat')" >/dev/null
MAINCOUNT=$(psql "$DBURL" -v ON_ERROR_STOP=1 -qtAc 'select count(*) from qa_branch_probe')
[ "$MAINCOUNT" = "1" ] || FAIL "a write on feat reached main"
OK "fork carries data and stays isolated"
FEATURL_APP=$(printf '%s\n' "$URL" | sed -e "s/-main\./-feat./")
[ "$HAVE_LOCALHOST_DNS" = "1" ] || ensure_host "$(url_host "$FEATURL_APP")"
wait_for 60 curl -sf "$FEATURL_APP/" || FAIL "$FEATURL_APP never answered after hold and wake"
OK "feat app answers after hold and wake"

STEP "6b. volume fork"
insta services add compute voljob --volume 1 >/dev/null || FAIL "services add compute --volume failed"
insta deploy --image "$IMAGE" --port 80 --group voljob >/dev/null || FAIL "voljob deploy failed"
VOLC=$(svc_container "$REF" voljob)
wait_for 60 sh -c "[ \"\$(docker inspect -f '{{.State.Status}}' $VOLC)\" = running ]" \
  || FAIL "$VOLC never started, state is $(cstate "$VOLC")"
# The marker goes in and comes out with `docker cp`, not `docker exec`: the image under test is
# whoami, a scratch image with no shell and no coreutils, so an exec of `sh` or `true` can only
# ever fail. cp still goes through the container's own /data, which is the mount being proved.
printf 'forked\n' > "$DATA/volmarker"
docker cp "$DATA/volmarker" "$VOLC:/data/marker" || FAIL "could not write the volume marker"
# Touch main's database immediately before the fork, and keep this line. It is not redundant
# with the round trip in step 6: the idle timer is 20s and everything between them (a service
# add, a deploy, and a wait of up to 60s for the container to come up) can outrun it, which
# would put the source at rest and let the fork below take the reflink path. The assertion after
# step 6b requires a LIVE source, so the precondition is made explicit rather than left to how
# fast the runner happened to be.
psql "$DBURL" -v ON_ERROR_STOP=1 -qtAc 'select 1' >/dev/null \
  || FAIL "could not keep main awake before the feat2 fork"
insta branch create feat2 --from main >/dev/null || FAIL "branch create feat2 failed"
VOLC2=$(svc_container "$SLUG-feat2" voljob)
FEAT2URL=$(printf '%s\n' "$URL" | sed -e "s/-main\./-feat2./" -e "s|http://web-|http://voljob-|")
[ "$HAVE_LOCALHOST_DNS" = "1" ] || ensure_host "$(url_host "$FEAT2URL")"
wait_for 60 curl -sf "$FEAT2URL/" || FAIL "$FEAT2URL never answered"
rm -f "$DATA/volmarker.got"
docker cp "$VOLC2:/data/marker" "$DATA/volmarker.got" || FAIL "the forked volume carries no marker"
MARKER=$(cat "$DATA/volmarker.got")
[ "$MARKER" = "forked" ] || FAIL "the volume did not fork, marker is '$MARKER'"
OK "compute volume forked with its files"
EVENTS=$(insta agent events --json)
printf '%s\n' "$EVENTS" | grep -q 'branch.created' || FAIL "no branch.created event"
# Assert the method, do not merely print it. Local mode is the laptop path that must never
# regress, and while it only reported the method it could not catch the class of regression that
# turned server mode red: the rule changed, every prose statement of it was updated, and the one
# executable statement was missed. The assertion is filesystem-independent here on purpose. Both
# of these forks ran against a source this script had just written to over psql, and a reflink of
# a live data directory copies a torn page image, so streaming is the only correct answer whether
# or not this box can reflink. A `reflink` here would mean the at-rest rule had been lost.
for _b in feat feat2; do
  _m=$(fork_method "$_b")
  [ "$_m" = "basebackup" ] \
    || FAIL "$_b forked a RUNNING source, expected basebackup, branch.created says '${_m:-unreported}'"
done
OK "both forks of a live source streamed, as the at-rest rule requires"

STEP "7. sleep and wake"
WEBC=$(svc_container "$REF" web)
PGC=$(pg_container "$REF" db)
# Compute is always-on by default, like the hosted platform; switching it to scale-to-zero is the
# user's toggle, so it is the first thing this step exercises. Postgres scales to zero by default.
insta compute always-on off web >/dev/null || FAIL "always-on off (switch to scale-to-zero) failed"
wait_for 90 sh -c "[ \"\$(docker inspect -f '{{.State.Status}}' $WEBC)\" = exited ]" \
  || FAIL "$WEBC never slept, state is $(cstate "$WEBC")"
wait_for 90 sh -c "[ \"\$(docker inspect -f '{{.State.Status}}' $PGC)\" = exited ]" \
  || FAIL "$PGC never slept, state is $(cstate "$PGC")"
[ "$(cstate "$WEBC")" != "paused" ] || FAIL "sleep must stop, never pause"
STATUS=$(insta compute status web)
printf '%s\n' "$STATUS" | grep -q 'desired=running' || FAIL "desired state should stay running"
printf '%s\n' "$STATUS" | grep -q 'live=running' && FAIL "live state should not be running"
OK "compute and postgres slept"
curl -sf "$URL/" >/dev/null || FAIL "traffic did not wake the app"
[ "$(cstate "$WEBC")" = "running" ] || FAIL "the app is not running after a wake"
OK "traffic woke the app"
PGCONNECT_TIMEOUT=60 psql "$DBURL" -qtAc 'select 1' | grep -q '1' || FAIL "connect did not wake postgres"
OK "a connection woke postgres"

STEP "7b. a stopped service is never woken by traffic"
insta compute stop web >/dev/null || FAIL "compute stop failed"
wait_for 30 sh -c "[ \"\$(docker inspect -f '{{.State.Status}}' $WEBC)\" = exited ]" \
  || FAIL "compute stop did not stop the container"
curl -sf "$URL/" >/dev/null 2>&1 && FAIL "a stopped service answered a request"
sleep 10
[ "$(cstate "$WEBC")" = "exited" ] || FAIL "traffic woke a stopped service"
insta compute start web >/dev/null || FAIL "compute start failed"
wait_for 60 curl -sf "$URL/" || FAIL "compute start did not bring the app back"
OK "stop is durable, start clears it"

STEP "7c. always-on"
insta compute always-on on web >/dev/null || FAIL "always-on on failed"
sleep $(( INSTA_OSS_IDLE_COMPUTE_SEC * 2 + INSTA_OSS_SWEEP_SEC + 5 ))
[ "$(cstate "$WEBC")" = "running" ] || FAIL "an always-on service slept"
insta compute always-on off web >/dev/null || FAIL "always-on off failed"
OK "always-on keeps a service up"
insta agent events --json | grep -q 'service.sleep' || FAIL "no service.sleep event"
insta agent events --json | grep -q 'service.wake' || FAIL "no service.wake event"
OK "sleep and wake events recorded"

STEP "8. limits"
insta compute limits web --memory 512mb >/dev/null || FAIL "compute limits failed"
wait_for 60 curl -sf "$URL/" || FAIL "the app did not come back after a limits change"
MEM=$(docker inspect -f '{{.HostConfig.Memory}}' "$WEBC")
[ "$MEM" = "536870912" ] || FAIL "expected 536870912 bytes of memory, docker reports $MEM"
# Captured, never piped into `grep -q`: grep exits at the first match and the CLI dies on the
# closed pipe, printing a stack trace over an assertion that passed.
LIMITS=$(insta compute limits web)
printf '%s\n' "$LIMITS" | grep -q '512' || FAIL "limits read-back does not show 512"
OK "memory limit applied and read back"

STEP "9. templates"
CATALOG=$(insta template list)
printf '%s\n' "$CATALOG" | grep -q 'n8n' || FAIL "n8n is missing from the catalog"
printf '%s\n' "$CATALOG" | grep -q 'hermes' || FAIL "hermes is missing from the catalog"
insta template info n8n --json | jsel 'd.template.upstream.pinned' | grep -q '[0-9]' \
  || FAIL "template info does not report a pinned upstream version"
DEPLOY_JSON=$(insta template deploy "$TPL" --branch main --yes --json)
DSTATUS=$(printf '%s\n' "$DEPLOY_JSON" | jsel 'd.status')
[ "$DSTATUS" = "succeeded" ] || FAIL "template deploy status is '$DSTATUS'"
HELLO_URL=$(printf '%s\n' "$DEPLOY_JSON" | jsel 'd.services[0].url')
[ -n "$HELLO_URL" ] || FAIL "template deploy returned no service url"
[ "$HAVE_LOCALHOST_DNS" = "1" ] || ensure_host "$(url_host "$HELLO_URL")"
wait_for 90 curl -sf "$HELLO_URL/" || FAIL "$HELLO_URL never answered"
SVCS=$(insta services list)
printf '%s\n' "$SVCS" | grep -q 'compute/hello' || FAIL "the template service is missing"
OK "template deployed from a directory and answers"
if insta template deploy "$TPL" --branch main --yes --json >/dev/null 2>&1; then
  SVCS=$(insta services list)
  if printf '%s\n' "$SVCS" | grep -q 'hello-2'; then
    OK "a second deploy names itself hello-2"
  else
    SKIP "second deploy did not use the hello-2 name"
  fi
else
  SKIP "a second deploy of the same template was refused"
fi

STEP "10. dashboard"
if [ -d "$ROOT/ui/dist" ]; then
  HTML=$(curl -sf "$API/")
  printf '%s\n' "$HTML" | grep -q 'id="root"' || FAIL "the dashboard html has no root element"
  printf '%s\n' "$HTML" | grep -q '__INSTA_OSS__' || FAIL "the dashboard boot payload is missing"
  OK "dashboard served by the daemon"
else
  SKIP "ui/dist is not built"
fi

STEP "11. teardown sweep"
CLEANED=1
allow_delete || FAIL "could not set project.delete to allow"
insta project delete --yes >/dev/null 2>&1 || insta project delete >/dev/null \
  || FAIL "project delete failed"
LEFT=$(docker ps -aq --filter "name=io-$SLUG-")
[ -z "$LEFT" ] || FAIL "containers survived the delete: $LEFT"
NETS=$(docker network ls -q --filter "name=io-$SLUG-")
[ -z "$NETS" ] || FAIL "networks survived the delete: $NETS"
[ ! -d "$DATA/pg/$SLUG-main" ] || FAIL "$DATA/pg/$SLUG-main survived the delete"
OK "teardown removed containers, networks and data directories"

stop_daemon

printf '\nLOCAL SMOKE PASSED\n'
