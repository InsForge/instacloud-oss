# Upstream's release image plus a launcher and a boot-time port holder. Nothing upstream ships is
# modified here: the two files this adds are new paths, and the migration edits the launcher makes
# happen inside the running container. LobeHub's license allows running it as a service unmodified
# and reserves derivative works to a commercial license, so the image this builds has to stay a
# copy of upstream's with a launcher beside it.
# The digest is the OCI INDEX's, not one architecture's child, so this still cross-builds.
FROM docker.io/lobehub/lobehub:2.2.19@sha256:56a21005ba1148ad45310e57e09f88ce25006cd6492b5b585e90cf92f4d1826f

COPY --chmod=0755 entrypoint.sh /insta-entrypoint.sh
COPY --chmod=0644 boot-listener.mjs /insta-boot-listener.mjs

EXPOSE 3210

# Replaces upstream's `/bin/node /app/startServer.js`, which runs the migrations before anything
# accepts on the port. The launcher ends by exec'ing that same script.
ENTRYPOINT ["/bin/sh", "/insta-entrypoint.sh"]
