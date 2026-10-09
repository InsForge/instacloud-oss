# Pinned to the OCI INDEX of gitea 1.27.3, never one of its children: the index carries amd64,
# arm64 and riscv64, and a child digest resolves to that one platform whatever --platform says.
# Repin with `docker buildx imagetools inspect docker.io/gitea/gitea:<tag>` and take the
# top-level Digest, not a Manifests row.
FROM docker.io/gitea/gitea:1.27.3@sha256:87a67ee09d3ae0d1df5fda5dcda3e2a1f9236a45b0a59025d6e00e46adc43bef

# The image supervises two services under s6: gitea and sshd. A compute service has exactly one
# routed port and it is the HTTP one, so nothing could ever connect to that sshd. Dropping it
# stops it writing three host keys onto the volume and logging at a port with no route. The
# matching "clone with SSH" affordance in the UI goes away with [server] DISABLE_SSH, which
# entrypoint.sh sets.
RUN rm -rf /etc/s6/openssh

# Upstream's own /usr/bin/entrypoint still runs, unchanged, as the last line of this one.
COPY --chmod=0755 entrypoint.sh /insta-entrypoint.sh
ENTRYPOINT ["/insta-entrypoint.sh"]
CMD ["/usr/bin/s6-svscan", "/etc/s6"]
