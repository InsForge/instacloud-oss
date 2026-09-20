# Upstream's own application image, unmodified apart from the process it starts.
#
# Pinned to the OCI INDEX digest of sha-771c1802... (= `edge` at the time of writing), not to one
# of its children: the child digests resolve to a single architecture whatever --platform asks for,
# and this template declares both. Upstream publishes no release tag yet, so a `sha-<commit>` tag
# is the only immutable name this image has.
FROM ghcr.io/elie222/rakazo/app:sha-771c18024d46a647ac5cd6e6334190a234bc8e1b@sha256:3e8f80fc055811efaa489c34b1c9dcbb999969bf3925cfd1ebddf8ce9b553b7e

# The overlay exists for one reason: upstream's CMD is `pnpm --filter @rakazo/api start`, which is
# the API alone, with no migrations, no worker and no web face. A template manifest carries no
# `command:` field, so the only place to say "run the stack, not one third of it" is here.
COPY entrypoint.sh /entrypoint.sh

# COPY lands root-owned and the image runs as USER node (uid 1000), which cannot chmod it.
# Switching back for one instruction is cheaper than teaching the platform to run an init step.
USER root
RUN chmod 755 /entrypoint.sh
USER node

# 5173 is the Vite preview server, the only port the manifest exposes. 3100 (API) stays on
# loopback inside the container; 7091 (the sandbox supervisor) is unused here.
EXPOSE 5173
CMD ["/entrypoint.sh"]
