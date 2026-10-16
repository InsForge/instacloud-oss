# Pinned by digest; the upstream tag floats.
FROM docker.io/nousresearch/hermes-agent:v2026.9.24@sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7

# Upstream's main process is the interactive TUI, which exits without a TTY. This
# image supplies the main process instead: bootstrap auth, bring up the s6-supervised
# gateway service, then serve the dashboard. Upstream's ENTRYPOINT stays: it routes
# an executable through, and on a deployed machine PID 1 is s6-svscan (a 2.1.x note
# here claimed Fly skips s6; observed machines say otherwise), so the s6 service
# tree the entrypoint relies on is present.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
CMD ["/entrypoint.sh"]
