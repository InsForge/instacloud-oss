# Upstream's release image, pinned by tag and by the index digest (the top-level Digest: of
# `docker buildx imagetools inspect apache/superset:6.0.0`, not one of its per-platform children),
# which carries linux/amd64 and linux/arm64.
FROM docker.io/apache/superset:6.0.0@sha256:6f6c9982bd64d81797bd4f33834f2ce4a4653c8ac8322f1e5f9df9b0332d092a

USER root

# Three files, and that is the whole overlay. Superset, gunicorn and the compiled assets are
# upstream's; see ./entrypoint.sh, ./boot-listener.py and ./superset_config.py for why each is here.
COPY entrypoint.sh /insta-entrypoint.sh
COPY boot-listener.py /insta-boot-listener.py
COPY db-revision.py /insta-db-revision.py
COPY superset_config.py /app/pythonpath/superset_config.py

# 6.0.0's run-server.sh launches gunicorn without exec, so the script stays PID 1 and a SIGTERM
# sent to PID 1 never reaches gunicorn: the container is killed on the grace timer instead of
# draining. The grep makes the build fail loudly rather than skip the patch silently if a later
# upstream adds the exec itself (master already has).
RUN grep -q '^gunicorn ' /app/docker/entrypoints/run-server.sh \
    && sed -i 's/^gunicorn /exec gunicorn /' /app/docker/entrypoints/run-server.sh \
    && chmod 0755 /insta-entrypoint.sh /insta-boot-listener.py /insta-db-revision.py \
    && chmod 0644 /app/pythonpath/superset_config.py

# Upstream's own user; the platform's volume ownership follows the image USER, so /data is writable.
USER superset

EXPOSE 8088
# Replaces upstream's CMD, which starts gunicorn against a database nothing has ever migrated.
ENTRYPOINT ["/insta-entrypoint.sh"]
