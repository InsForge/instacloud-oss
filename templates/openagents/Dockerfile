# Digest pins the exact release this template was verified against; the 0.8.0 tag stays for
# readability. The digest is the multi-arch INDEX, not one of its child manifests: a child digest
# carries one platform only, and `--platform linux/arm64` would silently resolve back to the amd64
# binary. Repin with `docker buildx imagetools inspect ghcr.io/openagents-org/openagents:<tag>` and
# take the top-level Digest, never one of the Manifests rows.
FROM ghcr.io/openagents-org/openagents:0.8.0@sha256:e30a74bf39b58cfd2fda79d3a0d8f3bfe5e34039904738624279999dbc49a100

# Seed the network workspace onto the platform volume, then hand over to upstream's entrypoint
# unchanged. Upstream's own entrypoint is left exactly as it ships.
COPY --chmod=0755 entrypoint.sh /insta-entrypoint.sh
ENTRYPOINT ["/insta-entrypoint.sh"]
