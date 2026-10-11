#!/bin/sh
set -e

# The password gets no fallback on purpose. The manifest declares it required with no default and
# no generator, so the platform always supplies it; a missing one means the image was started some
# other way, and inventing a value would publish an agent that runs shell commands behind a
# password every deploy in the world shares. Checked here so the failure is one readable line in
# the deploy log rather than nanobot's config-validation traceback, and before anything is written
# to the volume.
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

# --home is what moves nanobot's instance root off $HOME/.nanobot and onto the platform's volume:
# config.json, sessions, long-term memory, the WebUI's chat transcripts, cron, media, logs and the
# agent workspace all resolve from it.
home=/data
config="$home/config.json"

mkdir -p "$home/workspace"

# Seeded once and never overwritten. Provider keys, models, chat channels, MCP servers and skills
# are all configured in the WebUI and land in this same file, so rewriting it on every boot would
# discard everything the operator set up. The seed keeps ${ADMIN_PASSWORD} as a literal placeholder
# rather than the value: nanobot resolves it on a copy at load time (config/loader.py resolves env
# refs into a model_copy, and the settings writer saves what it read off disk), so rotating the
# variable and restarting rotates the password without touching the file.
if [ ! -f "$config" ]; then
    echo "[entrypoint] seeding $config"
    cp /opt/nanobot/config.seed.json "$config"
fi

# Upstream's entrypoint starts as root, hands the data directory to the non-root nanobot user and
# re-execs as that user, refusing to run the agent as root if it cannot. Same here, for the same
# reason: this process has a shell tool. The volume arrives root-owned on first boot, which is the
# only time the recursive chown has anything to do; afterwards the guard skips it, so a volume with
# a large workspace on it does not pay for the walk on every restart.
if [ "$(id -u)" = "0" ]; then
    if [ "$(stat -c %u "$home")" != "1000" ]; then
        echo "[entrypoint] handing $home to nanobot (uid 1000)"
        chown -R nanobot:nanobot "$home"
    fi
    echo "[entrypoint] dropping privileges to nanobot via setpriv"
    exec setpriv --reuid=nanobot --regid=nanobot --init-groups /entrypoint.sh "$@"
fi

exec nanobot --home "$home" gateway
