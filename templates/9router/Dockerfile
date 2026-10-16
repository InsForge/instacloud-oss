# Digest pins the exact release the volume fix was verified against; the 0.5.55 tag stays for
# readability. The digest is the multi-arch INDEX, not one child manifest. It used to be
# sha256:05d8d9ae..., which is the linux/amd64 child of this same index: a child digest carries no
# other platform, so `--platform linux/arm64` resolved back to the amd64 binary and this template
# was the reason an arm64 box could not run it. Repin with `docker buildx imagetools inspect
# docker.io/decolua/9router:<tag>` and take the top-level Digest, never one of the Manifests rows.
FROM docker.io/decolua/9router:0.5.55@sha256:f00fe389ef41a1999dd0d0275ad0c2955d13d176f7c4c5cb844b2f88c293c471

# Chown the platform volume to the user upstream's entrypoint drops to, then hand over unchanged.
COPY --chmod=0755 entrypoint.sh /insta-entrypoint.sh
ENTRYPOINT ["/insta-entrypoint.sh"]
CMD ["node", "custom-server.js"]
