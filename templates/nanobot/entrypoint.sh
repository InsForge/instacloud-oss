#!/bin/sh
set -e

# The password gets no fallback on purpose. The manifest declares it required with no default and
# no generator, so the platform always supplies it; a missing one means the image was started some
# other way, and inventing a value would publish an agent that runs shell commands behind a
# password every deploy in the world shares. Checked here so the failure is one readable line in
# the deploy log rather than nanobot's config-validation traceback, and before anything is written
# to the volume.
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

# HOME is the instance root, and moving it is the whole of how this template puts nanobot's state
# on the volume. nanobot resolves config.json, sessions, long-term memory, the WebUI's chat
# transcripts, cron, media, logs and the default workspace from ~/.nanobot, so with HOME=/data
# (set in the Dockerfile, where the platform mounts the volume) every one of them lands there.
# Nothing is passed on the command line: 0.3.5 has no --home flag, and --config would move the
# config alone while the helpers that fall back to Path.home() kept writing to the container's
# own filesystem, where a restart loses them.
dir="$HOME/.nanobot"

# Upstream's entrypoint starts as root, hands the data directory to the non-root nanobot user and
# re-execs as that user, refusing to run the agent as root if it cannot. Same here, for the same
# reason: this process has a shell tool. The volume arrives root-owned on first boot, which is the
# only time the recursive chown has anything to do. Afterwards the guard skips it, so a volume
# carrying a large workspace does not pay for the walk on every restart.
#
# The instance root and the seeded config are created below this block rather than above it, so
# they are made by nanobot and never by root. That is what makes a guard this cheap safe to keep:
# it reads one directory's owner, so anything root created inside an already-handed-over volume
# would slip past it. The case is real rather than theoretical. Clearing a bad config through the
# agent's own shell tool leaves the volume owned by uid 1000 with no instance root in it, and the
# next boot would seed a root-owned config.json that nanobot cannot write and the guard would skip.
if [ "$(id -u)" = "0" ]; then
    mkdir -p "$HOME"
    if [ "$(stat -c %u "$HOME")" != "1000" ]; then
        echo "[entrypoint] handing $HOME to nanobot (uid 1000)"
        chown -R nanobot:nanobot "$HOME"
    fi
    echo "[entrypoint] dropping privileges to nanobot via setpriv"
    exec setpriv --reuid=nanobot --regid=nanobot --init-groups /entrypoint.sh "$@"
fi

mkdir -p "$dir"

# Seeded once and never overwritten. Provider keys, models, chat channels, MCP servers and skills
# are all configured in the WebUI and land in this same file, so rewriting it on every boot would
# discard everything the operator set up. The seed keeps ${ADMIN_PASSWORD} as a literal placeholder
# rather than the value: nanobot resolves env refs onto a copy at load time and the settings writer
# saves what it read off disk, so rotating the variable and restarting rotates the password.
if [ ! -f "$dir/config.json" ]; then
    echo "[entrypoint] seeding $dir/config.json"
    cp /opt/nanobot/config.seed.json "$dir/config.json"
fi

exec nanobot gateway
