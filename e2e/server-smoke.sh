#!/bin/sh
# End-to-end smoke test for server mode: install.sh on a throwaway VM, then the whole
# public surface over https with a real admin and a real insta_ token.
#
#   sudo -E sh e2e/server-smoke.sh
#
# It installs a stack on THIS machine and leaves it running. Never point it at a box you
# care about.
#
# Inputs:
#   E2E_RUN_ID          suffix that keeps runs apart (server)
#   INSTA_OSS_IMAGE     daemon image to install (built from the checkout in CI)
#   INSTA_OSS_DOMAIN    default 127-0-0-1.sslip.io
#   INSTA_OSS_TLS       internal (the default here; acme needs a public name)
#   E2E_UNINSTALL       1 to compose down and unmount at the end
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
# shellcheck source=e2e/lib.sh disable=SC1091  # resolved at run time from $HERE, not cwd.
. "$HERE/lib.sh"

RUN=${E2E_RUN_ID:-server}
DOMAIN=${INSTA_OSS_DOMAIN:-127-0-0-1.sslip.io}
TLS=${INSTA_OSS_TLS:-internal}
IMAGE=${E2E_IMAGE:-traefik/whoami:v1.10}
PROJECT=e2e-server-$RUN
API=https://api.$DOMAIN
CA=/var/lib/instacloud/edge/ca.pem
# Outside the checkout, like the CLI scratch directory below: a smoke run has to leave the
# repository clean, and this file is written before /var/lib/instacloud exists.
INSTALL_LOG=${E2E_INSTALL_LOG:-${RUNNER_TEMP:-/tmp}/insta-oss-server-$RUN.log}
export INSTA_OSS_DOMAIN="$DOMAIN"
export INSTA_OSS_TLS="$TLS"
export API

INSTA_OSS_IDLE_COMPUTE_SEC=${INSTA_OSS_IDLE_COMPUTE_SEC:-15}
INSTA_OSS_IDLE_DB_SEC=${INSTA_OSS_IDLE_DB_SEC:-20}
INSTA_OSS_SWEEP_SEC=${INSTA_OSS_SWEEP_SEC:-2}
INSTA_OSS_CREATE_GRACE_SEC=${INSTA_OSS_CREATE_GRACE_SEC:-0}
INSTA_OSS_RAM_FLOOR_PCT=${INSTA_OSS_RAM_FLOOR_PCT:-0}
export INSTA_OSS_IDLE_COMPUTE_SEC INSTA_OSS_IDLE_DB_SEC INSTA_OSS_SWEEP_SEC
export INSTA_OSS_CREATE_GRACE_SEC INSTA_OSS_RAM_FLOOR_PCT

cleanup() {
  if command -v insta >/dev/null 2>&1; then
    allow_delete >/dev/null 2>&1 || true
  fi
  cd /
  [ -z "${WORK:-}" ] || rm -rf "$WORK"
  if [ "${E2E_UNINSTALL:-0}" = "1" ]; then
    ( cd /etc/instacloud && docker compose --env-file instad.env down -v ) || true
    umount /var/lib/instacloud 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

STEP "0. preflight"
[ "$(id -u)" = "0" ] || FAIL "run this as root (sudo -E sh e2e/server-smoke.sh)"
docker info >/dev/null 2>&1 || FAIL "docker is not running"
command -v psql >/dev/null 2>&1 || FAIL "psql is required (postgresql-client)"
command -v xfs_info >/dev/null 2>&1 || FAIL "xfsprogs is required"
for port in 80 443 5432; do
  if ss -ltn "sport = :$port" | grep -q LISTEN; then
    FAIL "port $port is already bound"
  fi
done
for host in api console s3; do
  ensure_host "$host.$DOMAIN"
done
OK "preflight"

STEP "1. install"
( cd "$ROOT" && sh install.sh -y ) 2>&1 | tee "$INSTALL_LOG"
grep -q "https://console.$DOMAIN/setup" "$INSTALL_LOG" || FAIL "no setup url in the install log"
grep -q 'Re-run this script to upgrade' "$INSTALL_LOG" || FAIL "no upgrade line in the install log"
for c in io-instad io-edge io-garage; do
  [ "$(cstate $c)" = "running" ] || FAIL "$c is not running, state $(cstate $c)"
done
OK "the three stack containers are up"
# Every CLI call from here on runs from a scratch directory, never from the checkout: `insta
# project create` links the directory it runs in, writing .insta/ and appending to .gitignore, and
# a smoke run has to leave the repository clean. Step 9's template path is absolute for the same
# reason. install.sh itself keeps running in a subshell that cds to the checkout.
TPL=$ROOT/e2e/fixtures/tpl-hello
WORK=${RUNNER_TEMP:-/tmp}/insta-oss-server-$RUN-work
rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK"
FSTYPE=$(findmnt -no FSTYPE /var/lib/instacloud)
if [ "$FSTYPE" = "xfs" ] && xfs_info /var/lib/instacloud | grep -q 'reflink=1'; then
  # Both ends inside the data directory: a reflink cannot cross a filesystem, and the install log
  # is not on this one.
  head -c 4096 /dev/urandom > /var/lib/instacloud/.e2e-reflink-src
  cp --reflink=always /var/lib/instacloud/.e2e-reflink-src /var/lib/instacloud/.e2e-reflink-probe \
    || FAIL "reflink copy failed on a reflink filesystem"
  rm -f /var/lib/instacloud/.e2e-reflink-src /var/lib/instacloud/.e2e-reflink-probe
  REFLINK=1
  OK "data dir is xfs with reflink=1"
else
  REFLINK=0
  SKIP "data dir is $FSTYPE without reflinks, fork timing will be soft"
fi
if [ -f "$CA" ]; then
  OK "internal CA at $CA"
else
  CA=
  INSECURE=1
  export INSECURE
  printf 'WARNING: no CA file, falling back to INSECURE=1\n'
fi

STEP "2. health and the auth wall"
wait_for 120 curl_healthz || FAIL "api healthz never answered"
CODE=$(NOAUTH=1 api_code GET /me)
[ "$CODE" = "401" ] || FAIL "GET /me without a token answered $CODE, expected 401"
CONSOLE=$(_curl "https://console.$DOMAIN/setup")
printf '%s\n' "$CONSOLE" | grep -q '__INSTA_OSS__' || FAIL "the setup page is not the dashboard"
OK "healthz public, everything else 401, setup page served"

STEP "3. admin and token"
PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -d '\n=' | cut -c1-24)
EMAIL=admin@example.test
SIGNUP_BODY=$(printf '{"name":"admin","email":"%s","password":"%s"}' "$EMAIL" "$PASSWORD")
CODE=$(_curl -o /tmp/signup.json -w '%{http_code}' -c /tmp/jar.txt \
  -X POST "$API/api/auth/sign-up/email" -H 'content-type: application/json' -d "$SIGNUP_BODY")
[ "$CODE" = "200" ] || FAIL "sign-up answered $CODE, expected 200"
CODE=$(_curl -o /dev/null -w '%{http_code}' -X POST "$API/api/auth/sign-up/email" \
  -H 'content-type: application/json' -d "$SIGNUP_BODY")
[ "$CODE" = "422" ] || FAIL "a second sign-up answered $CODE, expected 422"
OK "one admin, and only one"
TOKEN_JSON=$(_curl -b /tmp/jar.txt -X POST "$API/tokens" \
  -H 'content-type: application/json' -d '{"name":"ci"}')
TOKEN=$(printf '%s\n' "$TOKEN_JSON" | jsel 'd.token')
export TOKEN
case $TOKEN in
  insta_*) OK "minted an insta_ token" ;;
  *) FAIL "POST /tokens did not return an insta_ token: $TOKEN_JSON" ;;
esac
COUNT=$(api GET /tokens | jsel 'd.tokens.length')
[ "$COUNT" = "1" ] || FAIL "GET /tokens lists $COUNT records, expected 1"
OK "the token is listed"

STEP "4. cli login"
command -v insta >/dev/null 2>&1 || npm i -g insta@latest
if [ -n "$CA" ]; then
  NODE_EXTRA_CA_CERTS=$CA
  export NODE_EXTRA_CA_CERTS
  PGSSLROOTCERT=$CA
  export PGSSLROOTCERT
  # Each client reads its OWN variable. The S3 step used to be told nothing, so with
  # --tls internal it was the one call that could not verify the edge certificate every
  # other step had just verified: "SSL validation failed ... unable to get local issuer
  # certificate". botocore trusts AWS_CA_BUNDLE and nothing else.
  AWS_CA_BUNDLE=$CA
  export AWS_CA_BUNDLE
fi
insta login --api-key "$TOKEN" --api-url "$API" | grep -q "$EMAIL" \
  || FAIL "insta login did not print the admin email"
insta status | grep -q "$EMAIL" || FAIL "insta status does not show the admin email"
if insta login --api-key insta_bogus --api-url "$API" 2>&1 | grep -q 'reject'; then
  OK "a bad key is rejected before it is saved"
else
  FAIL "a bogus key was not rejected"
fi
insta login --api-key "$TOKEN" --api-url "$API" >/dev/null
OK "cli logged in"

STEP "5. project, services, credentials, deploy"
insta project create "$PROJECT" >/dev/null || FAIL "project create failed"
SLUG=$(slug "$PROJECT")
REF=$SLUG-main
insta services list | grep -q 'postgres/' && FAIL "a new project must start with no postgres"
insta services add postgres db >/dev/null || FAIL "services add postgres failed"
insta services add storage store >/dev/null || FAIL "services add storage failed"
insta services add compute web >/dev/null || FAIL "services add compute failed"
DBURL=$(insta postgres url)
DBHOST=$(url_host "$DBURL")
case $DBHOST in
  pg-db-*.$DOMAIN) OK "database host $DBHOST" ;;
  *) FAIL "unexpected database host $DBHOST" ;;
esac
case $DBURL in
  *:5432/*sslmode=require*) OK "public dsn on 5432 with sslmode=require" ;;
  *) FAIL "expected port 5432 and sslmode=require in $DBURL" ;;
esac
ensure_host "$DBHOST"
psql_roundtrip "$DBURL" || FAIL "postgres round trip over the public sni lane failed"
OK "postgres round trip over 5432"
SECRETS=$(insta secrets --print)
printf '%s\n' "$SECRETS" | grep -q "AWS_ENDPOINT_URL_S3=\"https://s3.$DOMAIN\"" \
  || FAIL "the s3 endpoint is not https://s3.$DOMAIN"
s3_roundtrip "$SECRETS" || FAIL "s3 round trip failed"
OK "s3 round trip at https://s3.$DOMAIN"
DEPLOY=$(insta deploy --image "$IMAGE" --port 80 --group web)
URL=$(printf '%s\n' "$DEPLOY" | tr ' ' '\n' | grep -o "https://web-[a-z0-9-]*\.$DOMAIN" | head -1)
[ -n "$URL" ] || FAIL "no https app url in the deploy output"
ensure_host "$(url_host "$URL")"
wait_for 90 curl_ok "$URL/" || FAIL "$URL never answered"
OK "app answers at $URL"
insta services add postgres analytics >/dev/null || FAIL "a second postgres must be allowed"
DBURL2=$(insta postgres url analytics)
[ "$DBURL2" != "$DBURL" ] || FAIL "the two postgres services share a dsn"
if insta services add postgres db >/dev/null 2>&1; then
  FAIL "a duplicate service name must be refused"
fi
OK "several postgres per branch, duplicates refused"

STEP "6. branch fork: a live parent streams, a parent at rest reflinks"
psql "$DBURL" -v ON_ERROR_STOP=1 -qtAc \
  "create table qa_branch_probe(v text); insert into qa_branch_probe values ('from-main')" \
  >/dev/null || FAIL "could not seed the probe table"
psql "$DBURL" -v ON_ERROR_STOP=1 -qtAc \
  "create table qa_bulk as select generate_series(1,700000) i, repeat('x',64) p" \
  >/dev/null || FAIL "could not seed 50 MB of bulk data"

# 6a. Fork a RUNNING parent. The seeding above left main's postgres live, and a reflink of a live
# data directory copies a torn page image, so this fork must stream with pg_basebackup instead.
# Asserting the method here is what keeps the safe path from silently regressing to a fast one.
measure insta branch create feat --from main >/dev/null || FAIL "branch create failed"
FEAT_MS=$MEASURED_MS
FEAT_IDS=$(insta services list --branch feat --json | jsel '(d.services||d).map(function(s){return s.id}).join(",")')
case $FEAT_IDS in
  *:pg-db*) OK "feat service ids are branch qualified" ;;
  *) FAIL "expected branch-qualified ids on feat, got $FEAT_IDS" ;;
esac
FEATURL=$(insta postgres url db --branch feat)
[ "$FEATURL" != "$DBURL" ] || FAIL "feat and main share a dsn"
FEATHOST=$(url_host "$FEATURL")
ensure_host "$FEATHOST"
FEATVAL=$(psql "$FEATURL" -v ON_ERROR_STOP=1 -qtAc 'select v from qa_branch_probe limit 1')
[ "$FEATVAL" = "from-main" ] || FAIL "feat did not inherit the seeded row"
FEATBULK=$(psql "$FEATURL" -v ON_ERROR_STOP=1 -qtAc 'select count(*) from qa_bulk')
[ "$FEATBULK" = "700000" ] || FAIL "feat inherited a torn copy of qa_bulk: $FEATBULK rows, expected 700000"
psql "$FEATURL" -v ON_ERROR_STOP=1 -qtAc \
  "insert into qa_branch_probe values ('only-on-feat')" >/dev/null
MAINCOUNT=$(psql "$DBURL" -v ON_ERROR_STOP=1 -qtAc 'select count(*) from qa_branch_probe')
[ "$MAINCOUNT" = "1" ] || FAIL "a write on feat reached main"
OK "fork carries data and stays isolated"
FEAT_APP=$(printf '%s\n' "$URL" | sed -e 's/-main\./-feat./')
ensure_host "$(url_host "$FEAT_APP")"
wait_for 90 curl_ok "$FEAT_APP/" || FAIL "$FEAT_APP never answered after hold and wake"
OK "the feat app answers after hold and wake"
FEAT_METHOD=$(fork_method feat)
[ "$FEAT_METHOD" = "basebackup" ] \
  || FAIL "a fork of a RUNNING parent must stream, branch.created says '$FEAT_METHOD'"
OK "a live parent streams (basebackup in ${FEAT_MS}ms)"

# 6b. Fork the same parent AT REST. Nothing has touched main since the count above, so the idle
# sweep stops its postgres, and only then is the reflink fast path legal. This is the arm that
# proves the sub-second fork, and it is the reason the data dir is on reflink-capable xfs.
MAINPG=$(pg_container "$REF" db)
wait_for 120 sh -c "[ \"\$(docker inspect -f '{{.State.Status}}' $MAINPG)\" = exited ]" \
  || FAIL "main postgres never went idle, state is $(cstate "$MAINPG")"
measure insta branch create rest --from main >/dev/null || FAIL "branch create from an idle parent failed"
RESTURL=$(insta postgres url db --branch rest)
ensure_host "$(url_host "$RESTURL")"
RESTBULK=$(psql "$RESTURL" -v ON_ERROR_STOP=1 -qtAc 'select count(*) from qa_bulk')
[ "$RESTBULK" = "700000" ] || FAIL "the at-rest fork is torn: $RESTBULK rows of qa_bulk, expected 700000"
RESTVAL=$(psql "$RESTURL" -v ON_ERROR_STOP=1 -qtAc 'select v from qa_branch_probe limit 1')
[ "$RESTVAL" = "from-main" ] || FAIL "the at-rest fork did not inherit the seeded row"
REST_METHOD=$(fork_method rest)
if [ "$REFLINK" = "1" ]; then
  # The method is the claim worth failing on: branch.created records what the fork actually did.
  [ "$REST_METHOD" = "reflink" ] \
    || FAIL "a fork of a parent AT REST must reflink, branch.created says '$REST_METHOD'"
  # The DURATION is not, by default. This measures the whole HTTPS round trip (checkpoint, reflink
  # copy, bucket clone, redeploy asleep), and on a runner without a reflink filesystem the data dir
  # is a loop-mounted image, which is not the substrate the sub-second figure was measured on. A
  # fixed wall-clock budget there fails on variance and takes the rest of the suite with it: steps
  # 7 to 11, including sleep and wake, had never run on CI because of this line. Over budget is a
  # warning; set INSTA_OSS_E2E_FORK_BUDGET_MS on a real VPS to enforce it.
  _budget=${INSTA_OSS_E2E_FORK_BUDGET_MS:-0}
  if [ "$_budget" -gt 0 ] && [ "${MEASURED_MS:-999999}" -ge "$_budget" ]; then
    FAIL "a reflink fork of 50 MB took ${MEASURED_MS}ms, over the ${_budget}ms budget"
  elif [ "${MEASURED_MS:-999999}" -ge 5000 ]; then
    SKIP "reflink fork in ${MEASURED_MS}ms (over the 5000ms reference; loop-mounted substrate?)"
  else
    OK "reflink fork in ${MEASURED_MS}ms"
  fi
else
  # No reflink filesystem, so the fast path is unavailable and streaming is the correct answer even
  # at rest. The method is still asserted: silence here would hide a fork that did neither.
  [ "$REST_METHOD" = "basebackup" ] \
    || FAIL "without reflinks a fork must stream, branch.created says '$REST_METHOD'"
  SKIP "at-rest fork streamed in ${MEASURED_MS}ms (no reflink filesystem)"
fi

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
insta compute status web | grep -q 'desired=running' || FAIL "desired state should stay running"
OK "compute and postgres slept"
curl_ok "$URL/" || FAIL "traffic did not wake the app"
[ "$(cstate "$WEBC")" = "running" ] || FAIL "the app is not running after a wake"
PGCONNECT_TIMEOUT=60 psql "$DBURL" -qtAc 'select 1' | grep -q '1' \
  || FAIL "a connection did not wake postgres"
OK "traffic and a connection woke both"
insta compute stop web >/dev/null
wait_for 30 sh -c "[ \"\$(docker inspect -f '{{.State.Status}}' $WEBC)\" = exited ]" \
  || FAIL "compute stop did not stop the container"
curl_ok "$URL/" 2>/dev/null && FAIL "a stopped service answered a request"
sleep 10
[ "$(cstate "$WEBC")" = "exited" ] || FAIL "traffic woke a stopped service"
insta compute start web >/dev/null
wait_for 60 curl_ok "$URL/" || FAIL "compute start did not bring the app back"
OK "stop is durable, start clears it"
insta compute always-on on web >/dev/null || FAIL "always-on on failed"
sleep $(( INSTA_OSS_IDLE_COMPUTE_SEC * 2 + INSTA_OSS_SWEEP_SEC + 5 ))
[ "$(cstate "$WEBC")" = "running" ] || FAIL "an always-on service slept"
insta compute always-on off web >/dev/null || FAIL "always-on off failed"
OK "always-on keeps a service up"
insta agent events --json | grep -q 'service.sleep' || FAIL "no service.sleep event"
insta agent events --json | grep -q 'service.wake' || FAIL "no service.wake event"
OK "sleep and wake events recorded"

STEP "8. custom domain"
SETOUT=$(insta domain attach e2e.example.test --group web)
printf '%s\n' "$SETOUT" | grep -q '501' && FAIL "domain attach still answers 501"
printf '%s\n' "$SETOUT" | grep -qi 'cname' || FAIL "domain attach printed no CNAME record"
printf '%s\n' "$SETOUT" | grep -q "api.$DOMAIN" || FAIL "the CNAME target is not api.$DOMAIN"
CHECK=$(insta domain check e2e.example.test)
printf '%s\n' "$CHECK" | grep -qi 'pending' || FAIL "domain check should report the record pending"
printf '%s\n' "$CHECK" | grep -q 'UNCONFIRMED' && FAIL "domain check must not print an ssl line"
insta domain detach e2e.example.test >/dev/null || FAIL "domain detach failed"
OK "custom domain add, check and remove"

STEP "9. templates over https"
insta template list | grep -q 'n8n' || FAIL "n8n is missing from the catalog"
CODE=$(NOAUTH=1 api_code GET /templates)
[ "$CODE" = "200" ] || FAIL "GET /templates without a bearer answered $CODE, expected 200"
DEPLOY_JSON=$(insta template deploy "$TPL" --branch main --yes --json)
DSTATUS=$(printf '%s\n' "$DEPLOY_JSON" | jsel 'd.status')
[ "$DSTATUS" = "succeeded" ] || FAIL "template deploy status is '$DSTATUS'"
HELLO_URL=$(printf '%s\n' "$DEPLOY_JSON" | jsel 'd.services[0].url')
ensure_host "$(url_host "$HELLO_URL")"
wait_for 90 curl_ok "$HELLO_URL/" || FAIL "$HELLO_URL never answered"
OK "template deployed and answers over https"

STEP "10. upgrade in place"
( cd "$ROOT" && sh install.sh -y ) 2>&1 | tee -a "$INSTALL_LOG"
wait_for 120 curl_healthz || FAIL "the daemon did not come back after the upgrade"
insta project list | grep -q "$PROJECT" || FAIL "the project is gone after the upgrade"
wait_for 90 curl_ok "$URL/" || FAIL "the app did not answer after the upgrade"
docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$PGC" \
  | grep -q '/var/lib/instacloud/pg/' || FAIL "postgres is not on a data-dir bind mount"
OK "upgrade is idempotent and data survived"

STEP "11. tls custom: one supplied certificate, and no per-host issuance"
# The parity break this mode closes. `acme` and `internal` both issue a certificate PER HOSTNAME
# on demand, so deploying a service publishes its exact hostname; measured on a live box, an ACME
# issuance put the hostname into the public certificate transparency logs and credential scanners
# arrived within minutes and kept arriving every 1 to 3 minutes, against a 300 s idle timer, so
# the compute service never slept. The cloud serves one wildcard and publishes nothing. What has
# to be true here is negative -- nothing issued, nothing published -- so this step asserts the
# absence of issuance rather than the presence of a certificate.
E2E_TLS_DIR=/etc/instacloud/e2e-tls
CADDYFILE=/etc/instacloud/Caddyfile
CERT_STORE=/var/lib/instacloud/caddy/data/caddy/certificates
mkdir -p "$E2E_TLS_DIR"
# TWO wildcards. A wildcard matches exactly one label, and this box serves two depths: every
# service name is `<label>.$DOMAIN`, and every bucket is `<bucket>.s3.$DOMAIN`, which
# `*.$DOMAIN` does NOT match. `AWS_ENDPOINT_URL_S3=https://s3.$DOMAIN` is injected into every
# deployed app and the SDKs address buckets virtual-hosted by default, so a single-wildcard
# certificate breaks storage for every app on the box in a mode that issues nothing.
openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes \
  -keyout "$E2E_TLS_DIR/wild.key" -out "$E2E_TLS_DIR/wild.crt" \
  -subj "/CN=*.$DOMAIN" -addext "subjectAltName=DNS:*.$DOMAIN,DNS:*.s3.$DOMAIN,DNS:$DOMAIN" >/dev/null 2>&1 \
  || FAIL "could not mint a wildcard certificate for *.$DOMAIN"
chmod 600 "$E2E_TLS_DIR/wild.key"
BEFORE=$(find "$CERT_STORE" -name '*.crt' 2>/dev/null | wc -l | tr -d ' ')

curl_k_ok() { curl -sS -k -o /dev/null -f "$1"; }
# The certificate's IDENTITY is a digest of it, not its serial: serials are unique only within
# one issuer and are reused, so two different certificates can carry the same number and a
# serial comparison would pass on one of them.
served_fp() {
  openssl s_client -connect "127.0.0.1:443" -servername "$1" </dev/null 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2
}
file_fp() { openssl x509 -in "$1" -noout -fingerprint -sha256 | cut -d= -f2; }
# After the definitions: a POSIX sh function does not exist until the line defining it has run,
# and a call above it dies with "not found" -- which neither `sh -n` nor shellcheck reports.
OURS=$(file_fp "$E2E_TLS_DIR/wild.crt")
# `healthz` carries the supplied certificate's own notAfter, so this asks the daemon WHICH file
# it is reading rather than trusting a log line. The renewal below has a different validity, so
# the two dates distinguish the old certificate from the new one.
healthz_notafter() {
  curl -sS -k "https://api.$DOMAIN/healthz" 2>/dev/null | sed -n 's/.*"notAfter":"\([^"]*\)".*/\1/p'
}
healthz_moved_from() {
  _was=$1
  _now=$(healthz_notafter)
  [ -n "$_now" ] || return 1
  [ "$_now" != "$_was" ]
}
healthz_matches_file() {
  _na=$(curl -sS -k "https://api.$DOMAIN/healthz" 2>/dev/null | sed -n 's/.*"notAfter":"\([^"]*\)".*/\1/p')
  [ -n "$_na" ] || return 1
  _want=$(date -u -d "$(openssl x509 -in "$E2E_TLS_DIR/wild.crt" -noout -enddate | cut -d= -f2)" +%s 2>/dev/null) || return 1
  _got=$(date -u -d "$_na" +%s 2>/dev/null) || return 1
  [ "$_want" = "$_got" ]
}

# ...and one wildcard is refused BEFORE anything is touched, naming the SAN that is missing.
# This is the shape that reached a live box: a certificate that looks complete, covers every
# service hostname, and silently does not cover the bucket URLs the apps are given.
openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes \
  -keyout "$E2E_TLS_DIR/one.key" -out "$E2E_TLS_DIR/one.crt" \
  -subj "/CN=*.$DOMAIN" -addext "subjectAltName=DNS:*.$DOMAIN,DNS:$DOMAIN" >/dev/null 2>&1 \
  || FAIL "could not mint the single-wildcard certificate"
ONE_OUT=$( ( cd "$ROOT" && INSTA_OSS_TLS=custom sh install.sh -y \
    --tls-cert "$E2E_TLS_DIR/one.crt" --tls-key "$E2E_TLS_DIR/one.key" ) 2>&1 ) && \
  FAIL "a certificate without DNS:*.s3.$DOMAIN was accepted: bucket URLs would fail hostname verification for every app"
printf '%s\n' "$ONE_OUT" | grep -Fq "does not carry the SAN DNS:*.s3.$DOMAIN" \
  || FAIL "the refusal did not name the missing SAN: $ONE_OUT"
rm -f "$E2E_TLS_DIR/one.crt" "$E2E_TLS_DIR/one.key"
OK "a single-wildcard certificate is refused, naming DNS:*.s3.$DOMAIN"

( cd "$ROOT" && INSTA_OSS_TLS=custom sh install.sh -y \
    --tls-cert "$E2E_TLS_DIR/wild.crt" --tls-key "$E2E_TLS_DIR/wild.key" ) 2>&1 | tee -a "$INSTALL_LOG"
grep -q "tls $E2E_TLS_DIR/wild.crt $E2E_TLS_DIR/wild.key" "$CADDYFILE" \
  || FAIL "the Caddyfile does not serve the supplied certificate"
if grep -q on_demand "$CADDYFILE"; then FAIL "the Caddyfile still configures on-demand issuance"; fi
for c in io-instad io-edge; do
  [ "$(cstate $c)" = "running" ] || FAIL "$c is not running after the custom-tls install, state $(cstate $c)"
done
wait_for 120 curl_k_ok "https://api.$DOMAIN/healthz" || FAIL "the edge did not answer api.$DOMAIN after the custom-tls install"
OK "the stack came up serving the supplied certificate"

# The two names an operator is handed, and a service hostname, all answer with OUR certificate.
for host in "api.$DOMAIN" "console.$DOMAIN" "$(url_host "$URL")"; do
  [ "$(served_fp "$host")" = "$OURS" ] || FAIL "$host is not served the supplied certificate"
done
# ...and a hostname that has NEVER existed on this box: served the same certificate, and the
# store Caddy writes issued certificates into gains nothing. That is the whole property.
NEVER="zz-never-$RUN.$DOMAIN"
[ "$(served_fp "$NEVER")" = "$OURS" ] || FAIL "$NEVER is not served the supplied certificate"
sleep 5
AFTER=$(find "$CERT_STORE" -name '*.crt' 2>/dev/null | wc -l | tr -d ' ')
[ "$AFTER" = "$BEFORE" ] || FAIL "the certificate store grew from $BEFORE to $AFTER: something was issued"
if docker logs io-edge 2>&1 | tail -200 | grep -q "certificate obtained successfully"; then
  FAIL "the edge obtained a certificate in custom mode"
fi
OK "a never-seen hostname is served without issuing anything"

# The BUCKET vhost, which is the name a single wildcard does not cover. Two labels in front of
# the domain, addressed by every AWS SDK by default, and the reason this mode needs the second
# wildcard. Verified, not just served: `--cacert` with the certificate itself makes curl check
# the HOSTNAME, which is exactly what `-k` throws away and what was failing.
BUCKET=$(printf '%s\n' "$SECRETS" | sed -n 's/^BUCKET_NAME="\(.*\)"$/\1/p')
[ -n "$BUCKET" ] || FAIL "no BUCKET_NAME in the printed secrets"
VHOST=$BUCKET.s3.$DOMAIN
[ "$(served_fp "$VHOST")" = "$OURS" ] || FAIL "$VHOST is not served the supplied certificate"
curl -sS -o /dev/null --cacert "$E2E_TLS_DIR/wild.crt" --resolve "$VHOST:443:127.0.0.1" "https://$VHOST/" \
  || FAIL "$VHOST does not VERIFY against the supplied certificate: a bucket URL fails hostname verification"
OK "the bucket vhost $VHOST verifies against the supplied certificate"

# The database lane presents a certificate too, and it is the other door issuance would publish a
# hostname through: the daemon triggers issuance by handshaking the edge with the wanted
# servername, so a wildcard at the edge alone would not have closed this.
PGHOST_NAME=pg-db-$SLUG-main.$DOMAIN
# `-starttls postgres` is how the lane's TLS is reached without a client library. It needs
# OpenSSL 1.1.1 or newer; where it is missing the check is SKIPPED loudly rather than passing
# quietly, because a silent skip of exactly this check is how the leak would come back.
if openssl s_client -help 2>&1 | grep -q 'starttls'; then
  LANE_FP=$(openssl s_client -connect "127.0.0.1:5432" -starttls postgres -servername "$PGHOST_NAME" </dev/null 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2)
  [ -n "$LANE_FP" ] || FAIL "the pg lane did not complete a TLS handshake for $PGHOST_NAME"
  [ "$LANE_FP" = "$OURS" ] || FAIL "the pg lane presented SHA-256 '$LANE_FP', not the supplied certificate '$OURS'"
  AFTER=$(find "$CERT_STORE" -name '*.crt' 2>/dev/null | wc -l | tr -d ' ')
  [ "$AFTER" = "$BEFORE" ] || FAIL "the pg lane handshake made something issue a certificate"
  OK "the database lane presents the supplied certificate and issues nothing"
else
  printf 'SKIP %s\n' "openssl has no -starttls: the database lane certificate check did not run" 1>&2
fi

# RENEWAL, done the way a renewal tool does it: write the new pair alongside and rename it over
# the old name. This is the test that catches the mount being wrong. A file bind mount resolves to
# an inode at mount time, so with the FILES mounted the containers keep reading the old
# certificate after the rename and the documented procedure is a lie that expires with the
# certificate. With the DIRECTORY mounted, the name is resolved through the mount on every open.
openssl req -x509 -newkey rsa:2048 -sha256 -days 3 -nodes \
  -keyout "$E2E_TLS_DIR/next.key" -out "$E2E_TLS_DIR/next.crt" \
  -subj "/CN=*.$DOMAIN" -addext "subjectAltName=DNS:*.$DOMAIN,DNS:*.s3.$DOMAIN,DNS:$DOMAIN" >/dev/null 2>&1 \
  || FAIL "could not mint the renewal certificate"
NEXT=$(file_fp "$E2E_TLS_DIR/next.crt")
# What `healthz` says BEFORE the rename, so the assertion after it is that the number MOVED. A
# check that only reads it once passes against a cache that never invalidates, which is exactly
# what a live-box renewal caught: same notAfter, same daysLeft, only secondsLeft ticking.
HEALTHZ_BEFORE=$(healthz_notafter)
[ -n "$HEALTHZ_BEFORE" ] || FAIL "healthz is not reporting a certificate before the renewal"
[ "$NEXT" != "$OURS" ] || FAIL "the renewal certificate is byte-identical to the first one"
chmod 600 "$E2E_TLS_DIR/next.key"
# ...and with the OLD timestamps put back on the new files. A rename changes the inode and need
# not change the mtime, and renewal and configuration tools routinely preserve timestamps, so a
# cache keyed on mtime alone serves the replaced certificate for the life of the process. The
# lane cache was exactly that, while `/healthz` was not, so the endpoint reported the renewal
# and psql was still handed the old file. `touch -r` reproduces that on a real box.
touch -r "$E2E_TLS_DIR/wild.crt" "$E2E_TLS_DIR/next.crt"
touch -r "$E2E_TLS_DIR/wild.key" "$E2E_TLS_DIR/next.key"
mv -f "$E2E_TLS_DIR/next.crt" "$E2E_TLS_DIR/wild.crt"
mv -f "$E2E_TLS_DIR/next.key" "$E2E_TLS_DIR/wild.key"

# The DAEMON needs nothing: it re-stats the path per handshake, and with the directory mounted it
# now resolves to the new file. `healthz` follows on its own beat.
LANE_AFTER=""
if openssl s_client -help 2>&1 | grep -q 'starttls'; then
  LANE_AFTER=$(openssl s_client -connect "127.0.0.1:5432" -starttls postgres -servername "$PGHOST_NAME" </dev/null 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2)
  [ "$LANE_AFTER" = "$NEXT" ] || FAIL "after the rename the pg lane still presents '$LANE_AFTER', not the renewed '$NEXT'"
fi
wait_for 90 healthz_moved_from "$HEALTHZ_BEFORE" || FAIL "healthz still reports the certificate it read before the rename"
healthz_matches_file || FAIL "healthz reports a notAfter that is not the file's"
OK "healthz followed the renewal: $HEALTHZ_BEFORE -> $(healthz_notafter)"

# The two have to AGREE. Divergence is the actual harm: an operator confirms a renewal on the
# endpoint while the lanes go on presenting the old certificate to every psql client.
if [ -n "$LANE_AFTER" ]; then
  [ "$LANE_AFTER" = "$NEXT" ] || FAIL "healthz reports the renewal but the pg lane presents '$LANE_AFTER'"
  OK "healthz and the database lane report the same certificate after the renewal"
fi
OK "the daemon and its lanes pick up a renamed certificate with no restart"

# The EDGE needs its process restarted (Caddy loads certificates at config load and does not
# watch the file), and that is all it needs now: the mount does not have to be recreated.
( cd /etc/instacloud && docker compose --env-file instad.env restart edge ) >/dev/null 2>&1 \
  || FAIL "could not restart the edge"
wait_for 90 curl_k_ok "https://api.$DOMAIN/healthz" || FAIL "the edge did not come back after the restart"
[ "$(served_fp "api.$DOMAIN")" = "$NEXT" ] \
  || FAIL "after a restart the edge still serves the old certificate: the documented renewal does not work"
AFTER=$(find "$CERT_STORE" -name '*.crt' 2>/dev/null | wc -l | tr -d ' ')
[ "$AFTER" = "$BEFORE" ] || FAIL "the renewal made something issue a certificate"
OK "the edge serves the renewed certificate after a plain restart"

# ...and back, because a box has to be able to leave this mode: the leftover paths in instad.env
# are not a request nothing can serve, they are the previous install.
( cd "$ROOT" && sh install.sh -y ) 2>&1 | tee -a "$INSTALL_LOG"
grep -q on_demand "$CADDYFILE" || FAIL "on-demand issuance did not come back with --tls $TLS"
wait_for 120 curl_healthz || FAIL "the daemon did not come back after leaving custom mode"
OK "the install moves back out of custom mode"

STEP "12. teardown"
allow_delete || FAIL "could not set project.delete to allow"
insta project delete --yes >/dev/null 2>&1 || insta project delete >/dev/null \
  || FAIL "project delete failed"
LEFT=$(docker ps -aq --filter "name=io-$SLUG-")
[ -z "$LEFT" ] || FAIL "containers survived the delete: $LEFT"
[ ! -d "/var/lib/instacloud/pg/$SLUG-main" ] || FAIL "the data directory survived the delete"
OK "teardown removed containers and data directories"

printf '\nSERVER SMOKE PASSED\n'
