# Upstream's release image plus an entrypoint, a boot-time port holder and an SNI preload.
FROM docker.io/twentycrm/twenty:v2.44.0

USER root

COPY entrypoint.sh /insta-entrypoint.sh
COPY boot-listener.mjs /insta-boot-listener.mjs
COPY sni.cjs /insta-sni.cjs
RUN chmod +x /insta-entrypoint.sh

# Upstream's uid; the platform's volume ownership follows the image USER, so /data is writable.
USER 1000

EXPOSE 3000
# Replaces upstream's ENTRYPOINT, which runs setup before anything holds the port.
ENTRYPOINT ["/insta-entrypoint.sh"]
