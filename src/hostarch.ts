// Which CPU architecture an image has to carry to run on this box, in OCI naming (`amd64`,
// `arm64`) -- the names an image index is keyed by, which is what decides whether a pull finds a
// manifest at all.
//
// The answer comes off the DOCKER DAEMON, not off this process: dockerd is what pulls, and it is
// not always the same machine as the one running instad (a remote DOCKER_HOST, a laptop VM).
// main.ts feeds it in from the boot `docker version` probe. Until then, and in a unit test that
// never boots, this process's own architecture stands in, which is exact inside the shipped image
// where node and dockerd share a kernel.
//
// Deliberately its own module rather than a corner of docker.ts: five test files mock `../docker`
// wholesale, and a catalog that reads the CPU through the CLI wrapper would break every one of
// them for a value the CLI wrapper does not own.

/** node's `process.arch` names differ from the OCI/Go ones. */
const NODE_ARCH_TO_OCI: Readonly<Record<string, string>> = {
  x64: 'amd64', arm64: 'arm64', arm: 'arm', ppc64: 'ppc64le', s390x: 's390x',
}
const OWN_ARCH: string = NODE_ARCH_TO_OCI[process.arch] ?? process.arch

let probedArch: string | null = null

/** Record what `docker version --format '{{.Server.Arch}}'` answered at boot. An empty string or
 *  `null` restores the fallback, which is how a test that set an architecture puts it back. */
export function initHostArch(arch: string | null): void {
  const v = (arch ?? '').trim()
  probedArch = v === '' ? null : v
}

/** The architecture an image must carry to run here. */
export function hostArch(): string {
  return probedArch ?? OWN_ARCH
}
