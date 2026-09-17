import { join } from 'node:path'
import { docker, destroyContainer } from '../docker'
import { MANAGED_DB, dataPaths } from '../manageddb'
import type { ManagedDbAdapter, ManagedDbTarget, ServiceLimits } from '../types'

// One managed-database container per branch per service (valkey/mysql/mongo), on the branch
// network only, so it is private like the cloud's private-tcp `.internal` hosts: reachable from the
// branch's compute containers at <container-name>:<port>. Handles are the container names the
// engine passes in. `dataDir` is `md/<ref>/<prefix>-<dataId>` under the data dir and every path the
// image writes is bind-mounted from a sub-directory of it; an empty `dataDir` (legacy rows before
// the boot migration) keeps the data in the container's own layer.
// `publishLoopback`/`limits` are read by WP2/WP3 at the marked lines.
export class LocalManagedDb implements ManagedDbAdapter {
  async provision(t: ManagedDbTarget, opts: { publishLoopback?: boolean; limits?: ServiceLimits } = {}): Promise<void> {
    const cfg = MANAGED_DB[t.type]
    const envArgs = Object.entries(cfg.env(t.password)).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    await docker(['run', '-d', '--restart', 'unless-stopped', '--name', t.container,
      '--network', t.network, ...envArgs,
      // ---- args WP2 ----
      // Local mode only (same reason as postgres): an ephemeral loopback port for `docker port`.
      ...(opts.publishLoopback ? ['-p', `127.0.0.1::${cfg.port}`] : []),
      // ---- args WP3 ----
      // The recorded cgroup ceiling, as on compute and postgres; no swap, so the container is
      // OOM-killed at its own ceiling rather than thrashing the host.
      ...(opts.limits ? ['--cpus', String(opts.limits.cpu), '--memory', `${opts.limits.memoryMb}m`, '--memory-swap', `${opts.limits.memoryMb}m`] : []),
      // ---- args WP4 ---- (one `--mount type=bind` per path the image writes, decision 56)
      ...(t.dataDir ? dataPaths(t.type).flatMap((p) => ['--mount', `type=bind,src=${join(t.dataDir, p.sub)},dst=${p.containerPath}`]) : []),
      cfg.image, ...(cfg.cmd ?? [])])
  }

  async destroy(container: string): Promise<void> {
    // `-v` drops the image's own anonymous volumes with the container; the engine removes the data
    // directory (a branch delete must not leave `md/<ref>/` behind) -- and it does that AFTER
    // this returns, so a failure swallowed here becomes a directory deleted under a container
    // that is still running. ONE implementation of that rule, shared with the postgres adapter.
    return destroyContainer(container, docker)
  }

  async rename(container: string, to: string): Promise<void> {
    // docker's embedded DNS follows the rename, so the re-minted bundle's new host resolves.
    await docker(['rename', container, to])
  }

  /** One client command inside the container, for the dashboard's key browser (valkey-cli today;
   *  the caller decides the args). Auth rides `REDISCLI_AUTH` in the exec's env, never argv, and
   *  `-e` is on docker.ts's redaction list, so the password reaches neither `docker ps` output nor
   *  a failed call's error message. */
  async command(container: string, password: string, args: string[]): Promise<string> {
    const out = await docker(['exec', '-e', `REDISCLI_AUTH=${password}`, container, 'valkey-cli', '--no-auth-warning', ...args])
    return out.toString().trim()
  }
}
