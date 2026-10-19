# Pinned by digest; the upstream tag floats.
FROM docker.io/nousresearch/hermes-agent:v2026.9.24@sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7

# nginx fronts the one port the platform routes, so two listeners can share it: the dashboard, and
# the Telegram webhook server the gateway opens when TELEGRAM_WEBHOOK_URL is set. The webhook path
# must not sit behind the dashboard's sign-in: Telegram authenticates each update with its own
# secret token, never with our username and password. See nginx.conf. Upstream is Debian 13, so
# nginx-light comes from apt like every other package in the image.
RUN apt-get update && apt-get install -y --no-install-recommends nginx-light patch \
    && rm -rf /var/lib/apt/lists/*
COPY nginx.conf /etc/nginx/hermes.conf
# Checked once here rather than on every boot: the config is baked in, so a wake cannot discover a
# new problem, and a broken config fails the BUILD instead of the container.
# The temp dir is removed again: the entrypoint runs as the unprivileged hermes user and creates it
# itself, and a root-owned leftover from this check makes nginx fail at runtime with EACCES.
RUN mkdir -p /tmp/hermes-nginx && nginx -t -c /etc/nginx/hermes.conf && rm -rf /tmp/hermes-nginx

# Telegram webhook mode already exists upstream, but on boot it registers the webhook with
# drop_pending_updates=True, on the (wrong) theory that Telegram keeps no queue for webhooks. It
# does keep every delivery it has no 2xx for yet, and on a machine that scales to zero the update
# that woke the machine is in flight while the gateway boots. Dropping pending updates there lost
# the first message after every wake (seen on the PoC). One line: keep them, Telegram redelivers.
COPY telegram-keep-pending-updates.patch /tmp/telegram-keep-pending-updates.patch
RUN patch -p1 -d /opt/hermes --forward --no-backup-if-mismatch < /tmp/telegram-keep-pending-updates.patch \
    && rm /tmp/telegram-keep-pending-updates.patch \
    && python3 -m py_compile /opt/hermes/plugins/platforms/telegram/adapter.py

# Slack over the inbound Events API. Upstream's Slack adapter speaks Socket Mode only, an outbound
# connection a scale-to-zero platform cannot see; slack_bolt ships aiohttp helpers for the Events
# API, and this patch wires them in behind SLACK_SIGNING_SECRET plus SLACK_EVENTS_URL. This image
# offers no Socket Mode. Applied against the digest-pinned upstream file, so a pin bump that touches
# the adapter fails this step loudly instead of drifting. Candidate for an upstream PR; see
# slack-events-api.patch for the change itself.
COPY slack-events-api.patch /tmp/slack-events-api.patch
RUN patch -p1 -d /opt/hermes --forward --no-backup-if-mismatch < /tmp/slack-events-api.patch \
    && rm /tmp/slack-events-api.patch \
    && python3 -m py_compile /opt/hermes/plugins/platforms/slack/adapter.py

# The dashboard's Channels page and the Slack plugin manifest describe Slack in Socket Mode terms
# (app-level token required). This image runs Slack over the Events API only, so the same patch
# mechanism rewrites that one card: bot token plus signing secret, the request URL to paste into the
# Slack app spelled out, and no app-level token field. One place to configure Slack, one story.
COPY dashboard-slack-events.patch /tmp/dashboard-slack-events.patch
RUN patch -p1 -d /opt/hermes --forward --no-backup-if-mismatch < /tmp/dashboard-slack-events.patch \
    && rm /tmp/dashboard-slack-events.patch \
    && python3 -m py_compile /opt/hermes/hermes_cli/web_server.py /opt/hermes/hermes_cli/config_defaults.py

# Upstream's main process is the interactive TUI, which exits without a TTY. This
# image supplies the main process instead: bootstrap auth, bring up the s6-supervised
# gateway service, then serve the dashboard behind nginx. Upstream's ENTRYPOINT stays: it
# routes an executable through, and on a deployed machine PID 1 is s6-svscan (a 2.1.x note
# here claimed Fly skips s6; observed machines say otherwise), so the s6 service
# tree the entrypoint relies on is present.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
CMD ["/entrypoint.sh"]
