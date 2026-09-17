#!/bin/bash
# Rakazo as one container, with its own Docker daemon inside it.
#
# Upstream's compose stack is five services: Postgres, an API (Hono, 3100), a graphile-worker, a
# Vite preview of the web app (5173, same-origin-proxying /api and /rpc to the API), and a sandbox
# supervisor that creates one container per bot computer over a Docker socket. Server-side template
# deploys support web services only in v1, so the middle four run here as siblings and Postgres is
# the managed `db` service the manifest declares.
#
# The supervisor is included because a compute machine is a VM, not a container: the root
# filesystem is ext4 rather than a stacked overlay, the process starts with the full capability
# set, and nothing stops it running a dockerd of its own. So the bot computers are siblings of a
# daemon that lives HERE, and the platform's own daemon is never involved. The one-way consequence
# of that is worth stating: this daemon's state (its images, its per-bot networks, the computer
# containers themselves) lives on the volume, and the volume is the only thing that survives.
#
# Deliberately not `set -e`: every failure below is handled with a message that names the cause,
# because the CLI collapses a failed template deploy into "internal template deployment failure"
# and these lines are the only thing left to read.
set -uo pipefail

log() { echo "entrypoint: $*" >&2; }

# node is uid 1000 in upstream's image. dockerd and the supervisor need root; the API, the worker
# and the web preview do not, and upstream runs them as node, so they keep running as node here.
#
# An array prefix rather than a shell function on purpose. setpriv EXECS the command it is given,
# so `"${as_app[@]}" pnpm ... &` makes $! the application process itself and a TERM reaches it
# directly; a function would have put a subshell in between and $! would have been the subshell.
as_app=(setpriv --reuid=node --regid=node --init-groups env HOME=/home/node)

# --- the volume -------------------------------------------------------------------------------
# This container's USER is root, so the volume arrives root-owned and the application user cannot
# write it. Upstream's compose has the same problem and solves it with a busybox init container
# that chowns its named volume; here the entrypoint is already root, so it does the same thing
# without one. /data itself only, never -R: a recursive chown over a bot's home directories and a
# Docker data-root is minutes of work on every boot, and both are created with the right owner.
mkdir -p "$DATA_DIR"
chown node:node "$DATA_DIR"
# The bot home directories. The API creates each bot's own directory as uid 1000 and the
# supervisor refuses to bind-mount one it does not own, so the parent has to be the app's.
install -d -o node -g node -m 750 "$DATA_DIR/homes"
# The Docker data-root stays root-only: it holds every computer's writable layer.
install -d -o root -g root -m 711 "$DATA_DIR/docker"
if ! "${as_app[@]}" touch "$DATA_DIR/.writable" 2>/dev/null; then
  log "FATAL: $DATA_DIR is still not writable by uid 1000 after chown; the volume is not ours"
  exit 1
fi
rm -f "$DATA_DIR/.writable"

# --- the Docker daemon ------------------------------------------------------------------------
# Both lines are best-effort on purpose. Some hosts hand the machine a read-only cgroup mount,
# which runc cannot create a cgroup under, and ip_forward off, which leaves a computer with no
# outbound network. Where they are already right, or where the kernel refuses, dockerd's own
# startup check below is what decides whether this container lives.
mount -o remount,rw /sys/fs/cgroup 2>/dev/null || true
echo 1 >/proc/sys/net/ipv4/ip_forward 2>/dev/null || true

docker_host="unix://$DOCKER_SOCKET"
log "starting dockerd (data-root $DATA_DIR/docker)"
# --storage-driver: named rather than auto-detected so a fallback to `vfs` (which copies the whole
#   image per container) is a startup failure instead of a computer that takes minutes to boot.
# --exec-opt native.cgroupdriver=cgroupfs: there is no systemd in this machine to own the cgroup
#   tree, and the default driver would look for one.
# --log-level=warn: the daemon's info stream is several hundred lines a boot, and this container's
#   log is already shared by four other processes.
dockerd \
  --host="$docker_host" \
  --data-root="$DATA_DIR/docker" \
  --storage-driver=overlay2 \
  --exec-opt native.cgroupdriver=cgroupfs \
  --log-level=warn &
dockerd_pid=$!

ready=""
for _ in $(seq 1 60); do
  if docker -H "$docker_host" version >/dev/null 2>&1; then ready=yes; break; fi
  if ! kill -0 "$dockerd_pid" 2>/dev/null; then
    log "FATAL: dockerd exited while starting; its own lines are above. A cgroup or storage-driver"
    log "       refusal reads there and nowhere else, and no manifest field can reach it."
    exit 1
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  log "FATAL: dockerd did not answer on $docker_host within 60s"
  kill -TERM "$dockerd_pid" 2>/dev/null
  exit 1
fi
log "dockerd ready: $(docker -H "$docker_host" info --format '{{.ServerVersion}} storage={{.Driver}} cgroup={{.CgroupDriver}}/{{.CgroupVersion}}' 2>/dev/null)"

# The computer image is ~400 MB compressed and upstream ships no way to preload it, so it is
# pulled here rather than baked into this image, and in the background rather than in front of the
# health check. It lands in the data-root on the volume, so this is a first-boot cost only. It
# overlaps the migrations below, which on an empty database are the longer of the two.
# Deliberately NOT one of the processes waited on at the bottom: a pull that finishes is a success,
# and a success must not take the container down.
(
  if docker -H "$docker_host" pull --quiet "$RAKAZO_COMPUTER_IMAGE" >/dev/null; then
    log "computer image ready: $RAKAZO_COMPUTER_IMAGE"
  else
    log "WARNING: pulling $RAKAZO_COMPUTER_IMAGE failed; the app runs but opening a bot computer"
    log "         will fail until it succeeds. Retry by restarting the service."
  fi
) &

# --- migrations -------------------------------------------------------------------------------
# First, to completion, single process. Both the API and the worker open the schema assuming it
# exists, and running `migrate deploy` from each would race on the migrations table.
log "applying database migrations"
if ! "${as_app[@]}" pnpm --filter @rakazo/db exec prisma migrate deploy; then
  log "FATAL: prisma migrate deploy failed; the lines above are Prisma's own. A connection or TLS"
  log "       error here is about DATABASE_URL, which the platform binds from the db service."
  exit 1
fi

# --- the application --------------------------------------------------------------------------
log "starting api, worker, web and the sandbox supervisor"
"${as_app[@]}" pnpm --filter @rakazo/api start &
api=$!
"${as_app[@]}" pnpm --filter @rakazo/worker start &
worker=$!
# --strictPort so a port surprise is a crash rather than a preview server that silently binds
# somewhere the platform is not routing to. host/port also come from the vite config, which reads
# WEB_PORT; passing them keeps this script's contract with the manifest explicit in one place.
"${as_app[@]}" pnpm --filter @rakazo/web preview --host 0.0.0.0 --port "$WEB_PORT" --strictPort &
web=$!
# The one process that stays root, because it drives the Docker socket. It binds loopback
# (SUPERVISOR_HOST in the manifest) and the platform routes only 5173, so the surface that is
# root-equivalent on this machine is not reachable from outside it.
pnpm --filter @rakazo/sandbox-supervisor start &
supervisor=$!

# The five are one application, so the first one to go down takes the container with it: an API
# with no worker silently stops running routines and waking bots, a dead preview server is an
# unreachable UI behind a machine that still looks alive, and a dead dockerd or supervisor is a
# deployment whose bots cannot think. The platform restarts on FAILURE only, so the exit status has
# to be non-zero even when the child exited 0 -- a clean exit here is a machine that lies there and
# is never brought back.
#
# The PIDs are listed rather than left to a bare `wait -n`, which would also return for the
# background pull above and take the container down the moment the pull succeeded.
wait -n "$dockerd_pid" "$api" "$worker" "$web" "$supervisor"
code=$?
log "a child process exited with status $code; stopping the others"
kill -TERM "$dockerd_pid" "$api" "$worker" "$web" "$supervisor" 2>/dev/null
wait "$dockerd_pid" "$api" "$worker" "$web" "$supervisor" 2>/dev/null
if [ "$code" -eq 0 ]; then code=1; fi
exit "$code"
