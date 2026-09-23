#!/bin/bash
# Three jobs, all of which upstream's image leaves to a human at a terminal.
#
# 1. Apply this template's settings on EVERY boot. Gitea folds environment variables named
#    GITEA__<section>__<KEY> into /data/gitea/conf/app.ini, but a platform env name has to match
#    ^[A-Z][A-Z0-9_]{0,63}$ and that form is lower-case in the middle, so the manifest cannot
#    declare it. The manifest declares plain upper-case names and they are translated below.
#    Those same names are also what the image's first-boot envsubst reads, but only on the first
#    boot: without this translation, changing a variable later would silently do nothing.
#
# 2. Point Gitea at the managed postgres. The platform mints exactly one canonical key for a
#    postgres service, DATABASE_URL, and Gitea has no field that takes a DSN, so it is taken
#    apart here into the five keys [database] actually reads.
#
# 3. Create the first administrator. Gitea's only route to a first account is its install wizard,
#    and this template locks that wizard so a public URL is never briefly an open installer
#    someone else can point at their own database. Nothing upstream fills the gap: there is no
#    GITEA_ADMIN_USERNAME in this image or in the rootless one.
set -eu

# Gitea's own check rejects a short password well into the create call, where the message is
# easy to miss in a boot log. Say it here instead, before anything has been written.
if [ "${#ADMIN_PASSWORD}" -lt 8 ]; then
  echo "insta: ADMIN_PASSWORD is ${#ADMIN_PASSWORD} characters, Gitea's [security] MIN_PASSWORD_LENGTH is 8" >&2
  exit 1
fi

# ---- 1. the settings this template fixes ------------------------------------------------------
# Four underscores is the root section of app.ini, where APP_NAME lives.
export GITEA____APP_NAME="${APP_NAME:-Gitea}"
export GITEA__server__ROOT_URL="${ROOT_URL}"
export GITEA__server__DOMAIN="${DOMAIN}"
export GITEA__server__HTTP_PORT="${HTTP_PORT}"
export GITEA__server__DISABLE_SSH="true"
# Objects land in /data/git/lfs, on the same volume as the repositories they belong to.
export GITEA__server__LFS_START_SERVER="true"
export GITEA__security__INSTALL_LOCK="true"
export GITEA__security__SECRET_KEY="${SECRET_KEY}"
export GITEA__service__DISABLE_REGISTRATION="${DISABLE_REGISTRATION:-true}"
export GITEA__service__REQUIRE_SIGNIN_VIEW="${REQUIRE_SIGNIN_VIEW:-true}"

# ---- 2. the managed postgres ------------------------------------------------------------------
# CANONICAL_KEYS.postgres is the single entry ['DATABASE_URL'] (src/manageddb.ts), and Gitea's
# [database] section reads HOST, NAME, USER, PASSWD and SSL_MODE as separate keys with no DSN
# field anywhere (modules/setting/database.go). So the URL is split here rather than passed on.
db_rest="${DATABASE_URL#*://}"
# Greedy from the right on purpose: a password may contain '@', a host may not.
db_creds="${db_rest%@*}"
db_hostpath="${db_rest##*@}"
# Gitea's HOST takes the host:port pair as one string and supplies 5432 when the port is absent.
db_hostport="${db_hostpath%%/*}"
db_tail="${db_hostpath#*/}"
db_name="${db_tail%%\?*}"
db_query=""
case "${db_tail}" in *\?*) db_query="${db_tail#*\?}" ;; esac
db_user="${db_creds%%:*}"
db_pass=""
case "${db_creds}" in *:*) db_pass="${db_creds#*:}" ;; esac

# Percent-decoding, because the password is URL-encoded into the DSN. A value with no '%' in it
# is passed through untouched, so an ordinary password can never be altered on the way here.
urldecode() {
  case "$1" in
    *%*) printf '%b' "${1//%/\\x}" ;;
    *) printf '%s' "$1" ;;
  esac
}
db_user=$(urldecode "${db_user}")
db_pass=$(urldecode "${db_pass}")

# sslmode rides in the query string when the lane wants TLS. Gitea's own default is disable, and
# DB_SSL_MODE overrides both, for a lane whose requirement is not written into the DSN.
db_ssl="disable"
case "${db_query}" in *sslmode=*) db_ssl="${db_query##*sslmode=}"; db_ssl="${db_ssl%%&*}" ;; esac
db_ssl="${DB_SSL_MODE:-${db_ssl}}"

export GITEA__database__DB_TYPE="postgres"
export GITEA__database__HOST="${db_hostport}"
export GITEA__database__NAME="${db_name}"
export GITEA__database__USER="${db_user}"
export GITEA__database__PASSWD="${db_pass}"
export GITEA__database__SSL_MODE="${db_ssl}"
# Everything but the password, so a connection problem can be read off the boot log directly.
echo "insta: database postgres host=${db_hostport} name=${db_name} user=${db_user} sslmode=${db_ssl}"

# ---- 3. the first administrator ---------------------------------------------------------------
# `gitea admin` needs app.ini, and app.ini is written by the s6 service script that starts the web
# server, which has not run yet. Source that same script here: it creates app.ini if missing,
# applies the GITEA__ variables above, and chowns the volume to the user gitea drops to. It is
# idempotent, and s6 sources it again a moment later when it starts `gitea web`.
# /data/gitea is the image's GITEA_CUSTOM; spelled out because the manifest does not declare it.
mkdir -p /data/gitea/conf /data/gitea/log /data/git
cd /app/gitea
# Sourced with -e and -u OFF, which is how upstream's own s6 run script invokes it. It reads
# INSTALL_LOCK with no default, unbound here because this template fixes that setting through
# the GITEA__ form instead, and -u would abort on it; and its `chown -R` over the whole
# volume is allowed to report a straggler on a later boot without taking the container down.
# What the script had to achieve is asserted straight afterwards instead.
set +eu
# shellcheck source=/dev/null
. /etc/s6/gitea/setup
set -eu
if [ ! -f /data/gitea/conf/app.ini ]; then
  echo "insta: /etc/s6/gitea/setup left no /data/gitea/conf/app.ini to configure" >&2
  exit 1
fi

# Seeding before the web server starts, rather than polling it afterwards, means the account
# exists by the time the port opens, so the health gate can never pass on an instance with no way
# in. The cost is that the database migration happens here instead, on the first boot only.
# Gitea's CLI opens the database but does not create its schema, so against an empty one the next
# command fails with `CreateUser: SQL logic error: no such table: user`. `gitea migrate` is
# upstream's answer and its own help says so, word for word: "Migrate the database, so that you
# can run gitea admin create user before starting the server". Idempotent on a later boot, where
# it checks the schema version and returns.
#
# Ten attempts, because this is the first thing in the container to open a connection and the
# managed postgres may still be accepting its own. `gitea web` retries its ORM init ten times for
# the same reason (routers/common/db.go), but the CLI does not retry at all, and without this a
# database that was a few seconds late would take the container down instead of waiting for it.
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if su-exec "${USER}" /usr/local/bin/gitea migrate; then break; fi
  if [ "${attempt}" -ge 10 ]; then
    echo "insta: gitea migrate failed 10 times, giving up" >&2
    exit 1
  fi
  echo "insta: gitea migrate attempt ${attempt} failed, retrying in 3s"
  sleep 3
done

existing=$(su-exec "${USER}" /usr/local/bin/gitea admin user list 2>/dev/null | awk 'NR > 1 { print $2 }' || true)
if printf '%s\n' "${existing}" | grep -Fxq "${ADMIN_USERNAME}"; then
  echo "insta: user '${ADMIN_USERNAME}' already exists, leaving it alone"
else
  echo "insta: creating the first administrator '${ADMIN_USERNAME}'"
  # A failure here is fatal on purpose. A Gitea nobody can sign into is not a working deploy, and
  # the reason (a rejected username, a password policy) is in the line above this one.
  su-exec "${USER}" /usr/local/bin/gitea admin user create \
    --username "${ADMIN_USERNAME}" \
    --password "${ADMIN_PASSWORD}" \
    --email "${ADMIN_EMAIL:-admin@example.com}" \
    --admin \
    --must-change-password=false
fi

# Upstream's entrypoint, unchanged, with the image's own CMD: /usr/bin/s6-svscan /etc/s6.
exec /usr/bin/entrypoint "$@"
