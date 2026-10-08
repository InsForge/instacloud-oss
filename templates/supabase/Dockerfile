# Supabase self-hosted at supabase/supabase self-hosted/v0.8.2: every image pin is that tag's compose.
ARG STUDIO_IMAGE=docker.io/supabase/studio:2026.09.07-sha-7996410@sha256:94a2a9d2906e8b4109e55159a62e241c3044709a492913ea8edd34b14973d288
ARG META_IMAGE=docker.io/supabase/postgres-meta:v0.99.0@sha256:9a079ac1c94d89629262822a4bd1902d5b1be4adb464e5a0a8fd078aaed72158
ARG STORAGE_IMAGE=docker.io/supabase/storage-api:v1.74.0@sha256:f1546fac6d1c7e345428ac904bfaa7be7cecd50a1f549fe1cf38c628a7b15c85
ARG IMGPROXY_IMAGE=docker.io/darthsim/imgproxy:v3.31.4@sha256:73c5dda13199745b0d2d00e4149d4a589c5b2e205dbf335ca05eca8276b54712
ARG ENVOY_IMAGE=docker.io/envoyproxy/envoy:v1.39.1@sha256:57e14a549d7bd43c8d3f6d03e8cfa653e037d4b38e133acd9b54f38c524401b4
ARG REALTIME_IMAGE=docker.io/supabase/realtime:v2.134.10@sha256:cbcc6a7986fc28b6dcffa798b077d5fb9c69cd25500371ab49147a86d7edbb03
ARG POSTGREST_IMAGE=docker.io/postgrest/postgrest:v14.17@sha256:c9dc201e555f5d8e37e7f39cdd4df0229774996e213bfd7de8d10ac609030f2c
ARG AUTH_IMAGE=docker.io/supabase/gotrue:v2.196.0@sha256:c0c25187a6b835e65a6f6e6c6b39d090e832d40e6de5186f2c038e0411944232
# The schema the compose's db image (supabase/postgres:17.6.1.136) starts from.
ARG POSTGRES_TAG=17.6.1.136
ARG POSTGRES_COMMIT=d156ba65c14694c12cc5e782bc15b9b8ed2d1376

FROM ${STUDIO_IMAGE} AS studio
FROM ${META_IMAGE} AS meta
FROM ${STORAGE_IMAGE} AS storage
FROM ${IMGPROXY_IMAGE} AS imgproxy
FROM ${ENVOY_IMAGE} AS envoy
FROM ${REALTIME_IMAGE} AS realtime
FROM ${POSTGREST_IMAGE} AS postgrest
FROM ${AUTH_IMAGE} AS auth

# storage-api ships Alpine (musl) builds of its native addons, so rebuild them against glibc.
FROM docker.io/library/node:24.20.0-trixie@sha256:f7d34e58713740f9eef9092c0bd6ff10369d132f7238399a4b270f16d47fa608 AS storage-glibc
COPY --from=storage /app /app
RUN cd /app && npm rebuild fs-xattr

FROM docker.io/library/node:24.20.0-trixie@sha256:f7d34e58713740f9eef9092c0bd6ff10369d132f7238399a4b270f16d47fa608 AS schema
ARG POSTGRES_TAG
ARG POSTGRES_COMMIT
RUN git clone --depth 1 --branch "${POSTGRES_TAG}" --filter=blob:none --sparse https://github.com/supabase/postgres.git /src \
    && git -C /src sparse-checkout set migrations/db \
    && test "$(git -C /src rev-parse HEAD)" = "${POSTGRES_COMMIT}" \
    && mkdir -p /out \
    && cp -r /src/migrations/db/init-scripts /src/migrations/db/migrations /out/ \
    && sed -i -E 's/DATABASE postgres/DATABASE :"dbname"/I' /out/init-scripts/*.sql \
    && printf '%s\n' "${POSTGRES_TAG}" > /out/VERSION

FROM docker.io/library/node:24.20.0-trixie-slim@sha256:50c3b2f6988dfc307b86e5301d69611af31f4789bdf232863b07d3b02fe55ae0
LABEL org.opencontainers.image.version="self-hosted/v0.8.2"

# Runtime libraries the realtime release links against, psql for the schema bootstrap, and tini as PID 1.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libgmp10 libncurses6 libpq5 libstdc++6 locales openssl postgresql-client tini \
    && sed -i '/en_US.UTF-8/s/^# //' /etc/locale.gen && locale-gen \
    && rm -rf /var/lib/apt/lists/*
ENV LANG=en_US.UTF-8 LANGUAGE=en_US:en LC_ALL=en_US.UTF-8
# Set by upstream's GoTrue image, which this one replaces for auth.
ENV GOTRUE_DB_MIGRATIONS_PATH=/usr/local/etc/auth/migrations

# Studio and postgres-meta keep the Node 22 their addons were built for. Storage uses this base's 24.
COPY --from=meta /usr/local/bin/node /usr/local/bin/node22
COPY --from=envoy /usr/local/bin/envoy /usr/local/bin/envoy
COPY --from=postgrest /bin/postgrest /usr/local/bin/postgrest
# GoTrue is a static binary. It runs here so auth can bootstrap the schema it logs in to.
COPY --from=auth /usr/local/bin/auth /usr/local/bin/auth
COPY --from=auth /usr/local/etc/auth/migrations /usr/local/etc/auth/migrations
COPY --from=imgproxy /opt/imgproxy /opt/imgproxy
COPY --from=realtime /app /opt/realtime
COPY --from=studio /app /opt/studio
COPY --from=meta /usr/src/app /opt/meta
COPY --from=storage-glibc /app /opt/storage
COPY --from=schema /out /opt/supabase-db

COPY realtime-seeds.exs /opt/realtime/lib/realtime-2.134.10/priv/repo/seeds.exs
COPY envoy/ /insta/envoy/
COPY bootstrap.sql /insta/bootstrap.sql
COPY entrypoint.sh /insta/entrypoint.sh
RUN chmod 0755 /insta/entrypoint.sh \
    && ln -s /opt/imgproxy/bin/imgproxy /usr/local/bin/imgproxy \
    && envoy --version && imgproxy version && postgrest --version && auth version && /opt/realtime/bin/realtime version

ENTRYPOINT ["/usr/bin/tini", "-s", "-g", "--", "/insta/entrypoint.sh"]
