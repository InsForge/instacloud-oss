import { docker } from '../docker'
import type { ComputeAdapter, ServiceLimits } from '../types'

const appName = (ref: string, group: string): string => `io-${ref}-app-${group}`

// Custom compute: runs the USER's image as a container on the branch network.
// Branch model = redeploy (replace-on-deploy; state lives in the branch's db/storage).
export class DockerCompute implements ComputeAdapter {
  // Persistent /data volumes are directories under the data dir, bind-mounted below; the engine
  // creates and removes them (04 section E), so a branch fork can reflink one.
  readonly supportsVolumes = true

  async deploy(
    ref: string,
    opts: {
      image: string; port: number; envVars: Record<string, string>; network?: string; group: string; start?: boolean
      hostPort?: number; hostAliases?: string[]; volume?: { hostPath: string }; limits?: ServiceLimits
    },
  ): Promise<{ url: string }> {
    const name = appName(ref, opts.group)
    if (!opts.network) throw new Error('DockerCompute requires the branch network')
    try { await docker(['rm', '-f', name]) } catch { /* not running yet */ }
    const envArgs = Object.entries(opts.envVars).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    // `hostPath` is `vol/<ref>/<volId>` under the data dir, created by the engine before the deploy
    // (`volumeMount`, mode 0777 because a user image may run as any uid). `--mount type=bind`,
    // never `-v` (decision 56): with `-v` dockerd CREATES a missing host directory, so a reboot
    // where the data volume failed to mount would hand the app an empty /data on the root
    // filesystem instead of failing the start. The data survives redeploys because only the
    // container is replaced.
    const volArgs = opts.volume ? ['--mount', `type=bind,src=${opts.volume.hostPath},dst=/data`] : []
    // create + conditional start, not `run -d`: a redeploy of a service the user stopped must not
    // run its entrypoint for the length of the redeploy. `--restart unless-stopped` is unaffected:
    // it only ever restarts containers that were RUNNING when the daemon went down, so one created
    // and never started stays down.
    await docker(['create', '--restart', 'unless-stopped', '--name', name, '--network', opts.network,
      ...envArgs,
      // ---- args WP2 ---- (`-p 127.0.0.1:<hostPort>:<port>` only when hostPort is set; `--add-host <h>:host-gateway` per hostAliases)
      // Local mode publishes on loopback (macOS cannot route to container IPs, and a port open on
      // 0.0.0.0 would put the app on the LAN); server mode publishes NOTHING and the router dials
      // the container IP on the branch network. The host-side mapping may differ between branch
      // clones; the app's listen port never changes.
      ...(opts.hostPort !== undefined ? ['-p', `127.0.0.1:${opts.hostPort}:${opts.port}`] : []),
      // Every hostname the branch mints resolves to the box itself from inside the container, so an
      // app can reach its own router URL, the API and the object store (decision 5).
      ...(opts.hostAliases ?? []).flatMap((h) => ['--add-host', `${h}:host-gateway`]),
      // ---- args WP3 ----
      // `--init`: docker's tini becomes PID 1 and forwards SIGTERM to an app whose entrypoint is a
      // shell (decision 60). Without it, sleep would end in SIGKILL after the whole grace for every
      // `sh -c "npm start"` image, which is most of them.
      '--init',
      // The cgroup ceiling `insta compute limits` records. `--memory-swap` equal to `--memory` means
      // no swap: the process is OOM-killed at its ceiling instead of thrashing the host's disk.
      ...(opts.limits ? ['--cpus', String(opts.limits.cpu), '--memory', `${opts.limits.memoryMb}m`, '--memory-swap', `${opts.limits.memoryMb}m`] : []),
      // ---- args WP4 ---- (`--mount type=bind,src=<hostPath>,dst=/data`)
      ...volArgs,
      opts.image])
    if (opts.start !== false) await docker(['start', name])
    // Informational only: the engine records the router URL (`serviceUrl`) on the row.
    return { url: `http://localhost:${opts.hostPort ?? opts.port}` }
  }

  async destroy(ref: string): Promise<void> {
    // Remove every compute group container for this branch ref.
    const out = await docker(['ps', '-aq', '--filter', `name=io-${ref}-app-`])
    const ids = out.toString().trim().split('\n').filter(Boolean)
    // `-v` drops each container's anonymous volumes with it. The branch's /data trees are
    // directories under the data dir now, and the ENGINE removes them after this call
    // (`data.remove(layout().vol(ref, id))`), so nothing here sweeps named volumes.
    if (ids.length) await docker(['rm', '-f', '-v', ...ids])
  }

  // ---- lifecycle (persistent developer intent; suspend = docker pause) ----
  // A paused container must be unpaused before start/stop can take effect.
  async start(ref: string, group: string): Promise<void> {
    const name = appName(ref, group)
    await docker(['unpause', name]).catch(() => { /* not paused */ })
    await docker(['start', name])
  }

  // The grace is the app's window to finish in-flight work before SIGKILL (`INSTA_OSS_STOP_GRACE_SEC`,
  // 10 s by default); a caller that passes none keeps docker's own 10 s default.
  async stop(ref: string, group: string, opts: { graceSec?: number } = {}): Promise<void> {
    const name = appName(ref, group)
    await docker(['unpause', name]).catch(() => { /* not paused */ })
    await docker(opts.graceSec !== undefined ? ['stop', '-t', String(opts.graceSec), name] : ['stop', name])
  }

  async suspend(ref: string, group: string): Promise<void> {
    await docker(['pause', appName(ref, group)])
  }

  async rename(ref: string, from: string, to: string): Promise<void> {
    await docker(['rename', appName(ref, from), appName(ref, to)])
  }

  // No `state()` (decision 53): the scheduler's `Runtime.containers()` is the one docker read and
  // `Engine.liveState` maps `scheduler.stateOf`, so there is no second opinion to disagree with.
}
