#!/bin/sh
# Two jobs, both of which upstream's image leaves to whoever is holding the keyboard.
#
# 1. Translate the template's variables into Ghost's. Ghost reads its whole configuration through
#    nconf, whose environment form is the config path joined by `__` and is lower-case in the
#    middle (`database__connection__host`, `paths__contentPath`). A platform env name has to match
#    ^[A-Z][A-Z0-9_]{0,63}$, so the manifest cannot declare one. The manifest declares plain
#    upper-case names and they are translated below, which is the same shape gitea's entrypoint
#    has for GITEA__<section>__<KEY>.
#
# 2. Create the site owner. Ghost's only route to a first account is the setup screen at /ghost,
#    which until somebody completes it is open to whoever reaches the URL first, on an instance
#    that will hold a member list and a Stripe connection. Nothing upstream fills the gap: there is
#    no GHOST_ADMIN_EMAIL in this image or in Ghost itself.
#
# Everything else is upstream's. The last line is its own docker-entrypoint.sh with its own CMD,
# so the chown of the content directory, the step down to the `node` user and the seeding of the
# stock themes all still happen, unchanged and in the same order.
set -eu

# ---- 1. the settings this template fixes ------------------------------------------------------

# The service's own public address. Ghost builds every absolute link from it (canonical tags, the
# RSS feed, member magic links) and the admin app will not talk to an origin that is not this one.
export url="${SITE_URL}"

# GHOST_CONTENT is what upstream's entrypoint chowns and seeds; this is what Ghost itself reads.
# One value in the manifest feeds both, so the directory the image prepares and the directory
# Ghost writes its uploads to cannot drift apart.
export paths__contentPath="${GHOST_CONTENT}"

# The port the image's baked config already binds, restated so the manifest's routed port, this
# process and setup-owner.cjs below all read the same number.
export server__port="${GHOST_PORT}"

# stdout only. Ghost's default also writes rotating log files under the content path, which here
# means filling the volume with a second copy of what `insta compute logs` already shows.
export logging__transports='["stdout"]'

# Ghost emails a six-digit code when a staff member signs in from a new device and refuses the
# sign-in until it is entered (shared/config/defaults.json has it on). On an instance with no SMTP
# configured that code is never delivered and nobody can ever sign in, so the default here is off.
# Turn it on with STAFF_DEVICE_VERIFICATION=true once outgoing mail works.
export security__staffDeviceVerification="${STAFF_DEVICE_VERIFICATION:-false}"

# ---- 2. the managed mysql ---------------------------------------------------------------------
# mysql2 is the knex client the official image installs: its Dockerfile runs
# `ghost install --db mysql`, and the baked config.production.json already names it. The five
# connection fields are separate keys with no DSN form anywhere in Ghost, which is why the
# manifest binds the bundle's five parts rather than MYSQL_URL.
export database__client="mysql2"
export database__connection__host="${DB_HOST}"
export database__connection__port="${DB_PORT}"
export database__connection__user="${DB_USER}"
export database__connection__password="${DB_PASSWORD}"
export database__connection__database="${DB_NAME}"
# Everything but the password, so a connection problem can be read off the boot log directly.
echo "insta: database mysql host=${DB_HOST} port=${DB_PORT} database=${DB_NAME} user=${DB_USER}"

# ---- 3. outgoing mail, when there is any ------------------------------------------------------
# Left entirely unset when MAIL_SMTP_HOST is empty, which is Ghost's "Direct" transport: it tries
# to deliver to the recipient's MX itself, and most networks drop that. Saying so is the README's
# job; silently configuring a broken SMTP server would be worse than leaving the default alone.
if [ -n "${MAIL_SMTP_HOST:-}" ]; then
  export mail__transport="SMTP"
  export mail__options__host="${MAIL_SMTP_HOST}"
  export mail__options__port="${MAIL_SMTP_PORT:-587}"
  # nconf parses env values, so these two arrive as a number and a boolean rather than strings.
  export mail__options__secure="${MAIL_SMTP_SECURE:-false}"
  if [ -n "${MAIL_SMTP_USER:-}" ]; then
    export mail__options__auth__user="${MAIL_SMTP_USER}"
    export mail__options__auth__pass="${MAIL_SMTP_PASSWORD:-}"
  fi
  echo "insta: smtp ${MAIL_SMTP_HOST}:${MAIL_SMTP_PORT:-587}"
fi
if [ -n "${MAIL_FROM:-}" ]; then
  export mail__from="${MAIL_FROM}"
fi

# ---- 4. the site owner ------------------------------------------------------------------------
# Ghost's own rules, checked here rather than inside the setup call, where the message would
# arrive several seconds into the boot log and read as a crash.
if [ -z "${ADMIN_EMAIL:-}" ] || [ -z "${ADMIN_PASSWORD:-}" ]; then
  echo "insta: ADMIN_EMAIL and ADMIN_PASSWORD are both required" >&2
  exit 1
fi
if [ "${#ADMIN_PASSWORD}" -lt 10 ]; then
  echo "insta: ADMIN_PASSWORD is ${#ADMIN_PASSWORD} characters, Ghost's own minimum is 10" >&2
  exit 1
fi

# In the background, unlike gitea's equivalent, because Ghost has no CLI for this: the only way in
# is its own HTTP setup endpoint, so the server has to be listening first. Ghost opens the port in
# step 2 of its boot with a maintenance-mode app and only then touches the database, so the wait
# is short and the script polls rather than guessing. It is idempotent: it asks whether an owner
# exists before it creates one, and Ghost refuses a second setup anyway.
gosu node node /insta-setup-owner.cjs &

# Upstream's entrypoint, unchanged, with the image's own CMD: node current/index.js.
exec /usr/local/bin/docker-entrypoint.sh "$@"
