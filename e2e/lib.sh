#!/bin/sh
# Shared helpers for the insta-oss end-to-end scripts. POSIX sh, no bashisms.
#
# Callers set before using these:
#   API      base API url, for example http://127.0.0.1:8080
#   TOKEN    bearer token (optional; local mode needs none)
#   CA       path to a CA file to trust (optional)
#   INSECURE 1 to skip certificate verification (last resort)

FAIL() {
  printf 'FAIL %s\n' "$*" 1>&2
  exit 1
}

OK() {
  printf 'ok   %s\n' "$*"
}

SKIP() {
  printf 'skip %s\n' "$*"
}

STEP() {
  printf '\n=== %s\n' "$*"
}

# Every curl goes through this, so TLS trust is decided in one place.
_curl() {
  if [ -n "${CA:-}" ]; then
    curl -sS --cacert "$CA" "$@"
  elif [ "${INSECURE:-0}" = "1" ]; then
    curl -sS -k "$@"
  else
    curl -sS "$@"
  fi
}

_auth() {
  if [ -n "${TOKEN:-}" ]; then
    printf 'authorization: Bearer %s' "$TOKEN"
  else
    printf 'x-e2e: 1'
  fi
}

# api METHOD PATH [BODY] -> response body on stdout
api() {
  if [ -n "${3:-}" ]; then
    _curl -X "$1" "$API$2" -H "$(_auth)" -H 'content-type: application/json' -d "$3"
  else
    _curl -X "$1" "$API$2" -H "$(_auth)"
  fi
}

# api_code METHOD PATH [BODY] -> HTTP status code. NOAUTH=1 sends no credentials.
api_code() {
  if [ "${NOAUTH:-0}" = "1" ]; then
    _curl -o /dev/null -w '%{http_code}' -X "$1" "$API$2"
  elif [ -n "${3:-}" ]; then
    _curl -o /dev/null -w '%{http_code}' -X "$1" "$API$2" -H "$(_auth)" \
      -H 'content-type: application/json' -d "$3"
  else
    _curl -o /dev/null -w '%{http_code}' -X "$1" "$API$2" -H "$(_auth)"
  fi
}

# jsel EXPR: read JSON on stdin, print EXPR evaluated with the document bound to d.
# Prints an empty line when the value is missing, so callers can test for empty.
jsel() {
  node -e '
    let s = "";
    process.stdin.on("data", function (c) { s += c; });
    process.stdin.on("end", function () {
      var d;
      try { d = JSON.parse(s); } catch (e) { process.stdout.write("\n"); return; }
      var v;
      try { v = eval(process.argv[1]); } catch (e) { v = undefined; }
      process.stdout.write((v === undefined || v === null ? "" : String(v)) + "\n");
    });
  ' "$1"
}

# fork_method BRANCH : the copy method branch.created recorded for BRANCH, empty if it recorded
# none. Filtered on the event's branch, not on position: a suite that forks more than once emits
# more than one branch.created, and reading [0] of the unfiltered list silently grades the wrong
# fork.
fork_method() {
  insta agent events --json | jsel '(d.events||d).filter(function(e){return e.kind==="branch.created"&&e.branch==="'"$1"'"}).map(function(e){return (e.payload&&e.payload.db&&e.payload.db.method)||""}).filter(Boolean)[0]||""'
}

# allow_delete : flip the linked project's project.delete gate to allow, so the teardown is not
# stopped by an approval. Through the route, not `insta agent policy` or `insta agent approvals`:
# a cleanup path must not depend on the CLI's governance verbs or on consuming a one-shot grant.
allow_delete() {
  _pid=$(insta agent manifest --json 2>/dev/null | jsel 'd.project.id')
  [ -n "$_pid" ] || return 1
  [ "$(api_code PUT "/projects/$_pid/policy/project.delete" '{"decision":"allow"}')" = "200" ]
}

# wait_for SECONDS CMD... : run CMD every second until it succeeds. Returns 1 on timeout.
wait_for() {
  _deadline=$1
  shift
  _n=0
  while [ "$_n" -lt "$_deadline" ]; do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    _n=$((_n + 1))
    sleep 1
  done
  return 1
}

# cstate NAME -> docker state of a container, or "none" when it does not exist.
cstate() {
  _s=$(docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null) || _s=none
  [ -n "$_s" ] || _s=none
  printf '%s\n' "$_s"
}

# url_host URL -> the host part, without scheme, userinfo, port or path. The userinfo matters:
# every DSN this file is asked about carries `user:password@` in front of the host.
url_host() {
  printf '%s\n' "$1" | sed -e 's|^[a-z]*://||' -e 's|^.*@||' -e 's|/.*$||' -e 's|:.*$||'
}

# resolves NAME : can this host be reached by name? The system resolver first, which is what psql
# and every non-curl client use, then curl, which maps the reserved .localhost TLD to loopback
# itself (RFC 6761) on a box whose resolver does not, and is what these scripts use for app URLs.
# `getent` did both jobs on glibc and exists on no other platform.
resolves() {
  if node -e 'require("dns").lookup(process.argv[1], function (e) { process.exit(e ? 1 : 0) })' \
      "$1" >/dev/null 2>&1; then
    return 0
  fi
  _rc=0
  curl -s -o /dev/null --connect-timeout 2 --max-time 3 "http://$1:1/" >/dev/null 2>&1 || _rc=$?
  [ "$_rc" != "6" ]   # 6 is curl's "could not resolve host"; anything else got that far
}

# ensure_host NAME [IP] : make NAME resolve, falling back to /etc/hosts.
# Needed for *.localhost on Linux hosts without systemd-resolved, and for sslip.io
# names on a runner with no outbound DNS.
ensure_host() {
  _name=$1
  _ip=${2:-127.0.0.1}
  if resolves "$_name"; then
    return 0
  fi
  if grep -q "[[:space:]]$_name\$" /etc/hosts 2>/dev/null; then
    return 0
  fi
  printf '%s %s\n' "$_ip" "$_name" | sudo tee -a /etc/hosts >/dev/null
  OK "added $_name to /etc/hosts"
}

# svc_container REF GROUP / pg_container REF NAME : the engine naming rules.
svc_container() {
  printf 'io-%s-app-%s\n' "$1" "$2"
}

pg_container() {
  printf 'io-%s-pg-%s\n' "$1" "$2"
}

# slug NAME : the engine slug rule (lowercase, non-alphanumeric to dashes, trimmed, 20 chars).
slug() {
  # shellcheck disable=SC2019,SC2018  # ASCII on purpose: this mirrors the engine's slug(), which
  # reduces to [a-z0-9-]; a locale-aware class would accept characters the engine then strips.
  printf '%s\n' "$1" | tr 'A-Z' 'a-z' | sed -e 's/[^a-z0-9]\{1,\}/-/g' \
    -e 's/^-\{1,\}//' -e 's/-\{1,\}$//' | cut -c1-20
}

# _now_ms : wall clock in milliseconds. GNU date where it has nanoseconds, node otherwise
# (macOS date has no %N), so `measure` is never limited to whole-second resolution.
_now_ms() {
  _ns=$(date +%s%N 2>/dev/null)
  case $_ns in
    *N|'') node -e 'process.stdout.write(String(Date.now()))' ;;
    *) printf '%s\n' $((_ns / 1000000)) ;;
  esac
}

# measure CMD... : run CMD, print its elapsed milliseconds into MEASURED_MS.
measure() {
  _t0=$(_now_ms)
  "$@"
  _rc=$?
  _t1=$(_now_ms)
  # shellcheck disable=SC2034  # read by callers after this function returns, not in this file.
  MEASURED_MS=$((_t1 - _t0))
  return $_rc
}

# psql_roundtrip DSN : create, insert, read back and drop a table. Proves the lane end to end.
psql_roundtrip() {
  _dsn=$1
  if [ -n "${CA:-}" ]; then
    PGSSLROOTCERT=$CA
    export PGSSLROOTCERT
  fi
  PGCONNECT_TIMEOUT=${PGCONNECT_TIMEOUT:-60}
  export PGCONNECT_TIMEOUT
  psql "$_dsn" -v ON_ERROR_STOP=1 -qtAc \
    "create table if not exists e2e_probe(v text)" >/dev/null || return 1
  psql "$_dsn" -v ON_ERROR_STOP=1 -qtAc \
    "insert into e2e_probe values ('marker')" >/dev/null || return 1
  _got=$(psql "$_dsn" -v ON_ERROR_STOP=1 -qtAc "select v from e2e_probe limit 1") || return 1
  psql "$_dsn" -v ON_ERROR_STOP=1 -qtAc 'drop table e2e_probe' >/dev/null || return 1
  [ "$_got" = "marker" ] || return 1
  return 0
}

# _aws ARGS... : the aws CLI if it is installed, else the official image over the host network.
# The CA follows the same three-way shape as _curl, through the variable botocore actually reads.
# The AWS CLI trusts neither NODE_EXTRA_CA_CERTS nor PGSSLROOTCERT nor --cacert: its trust store
# is AWS_CA_BUNDLE, which the caller exports beside the other two. In the container the bundle has
# to be mounted at the path that variable names, or it points at nothing.
_aws() {
  _aws_flags=''
  if [ -z "${AWS_CA_BUNDLE:-}" ] && [ "${INSECURE:-0}" = "1" ]; then
    _aws_flags='--no-verify-ssl'
  fi
  if command -v aws >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    aws $_aws_flags "$@"
  else
    # shellcheck disable=SC2086
    docker run --rm --network host \
      -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_ENDPOINT_URL_S3 \
      -e AWS_DEFAULT_REGION=garage -e AWS_CA_BUNDLE \
      ${AWS_CA_BUNDLE:+-v $AWS_CA_BUNDLE:$AWS_CA_BUNDLE:ro} \
      -v /tmp:/tmp amazon/aws-cli:2.15.0 $_aws_flags "$@"
  fi
}

# s3_roundtrip SECRETS_TEXT : put, get, compare and delete one object at the printed endpoint.
# The endpoint is used exactly as the daemon printed it: rewriting it would test nothing.
s3_roundtrip() {
  _txt=$1
  AWS_ACCESS_KEY_ID=$(printf '%s\n' "$_txt" | sed -n 's/^AWS_ACCESS_KEY_ID="\(.*\)"$/\1/p')
  AWS_SECRET_ACCESS_KEY=$(printf '%s\n' "$_txt" | sed -n 's/^AWS_SECRET_ACCESS_KEY="\(.*\)"$/\1/p')
  AWS_ENDPOINT_URL_S3=$(printf '%s\n' "$_txt" | sed -n 's/^AWS_ENDPOINT_URL_S3="\(.*\)"$/\1/p')
  _bucket=$(printf '%s\n' "$_txt" | sed -n 's/^BUCKET_NAME="\(.*\)"$/\1/p')
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_ENDPOINT_URL_S3
  AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-garage}
  export AWS_DEFAULT_REGION
  [ -n "$_bucket" ] || return 1
  printf 'hello-e2e\n' > /tmp/e2e-s3-put.txt
  _aws s3 cp /tmp/e2e-s3-put.txt "s3://$_bucket/e2e/probe.txt" >/dev/null || return 1
  _aws s3 cp "s3://$_bucket/e2e/probe.txt" /tmp/e2e-s3-got.txt >/dev/null || return 1
  grep -q 'hello-e2e' /tmp/e2e-s3-got.txt || return 1
  _aws s3 rm "s3://$_bucket/e2e/probe.txt" >/dev/null || return 1
  return 0
}

# curl_healthz : GET $API/healthz through _curl, for wait_for.
curl_healthz() {
  _curl -o /dev/null -f "$API/healthz"
}

# curl_ok URL : GET URL through _curl and fail on a non-2xx, for wait_for.
curl_ok() {
  _curl -o /dev/null -f "$1"
}
