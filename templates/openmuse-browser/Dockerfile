# The OpenMuse browser worker: a private Chromium service the openmuse template's API drives for
# page reads, screenshots and Take control. It is a second image, and a template directory builds
# exactly one, so it lives in its own directory here and the `openmuse` manifest references the image
# this builds as a second service. Upstream runs it the same way: render.yaml deploys apps/worker as
# its own `openmuse-browser` service alongside the API.
#
# Upstream publishes no image for it, so it is built from the same pinned OpenMuse commit as the API.
# Base pinned by digest: the Playwright image already carries the matching Chromium build, so the
# worker's own `npm ci` runs with --ignore-scripts and downloads no browser.
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e

RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# upstream pin: keep in sync with insta.template.yaml (upstream.commit). The worker is apps/worker in
# the OpenMuse monorepo; it has its own npm lockfile, separate from the API's pnpm workspace.
ARG OPENMUSE_COMMIT=9ec439fbaa878197d9d44c2aa982cca55676dd68
RUN git clone --filter=blob:none https://github.com/CopilotKit/OpenMuse.git /src \
 && git -C /src checkout --detach "$OPENMUSE_COMMIT" \
 && rm -rf /src/.git

WORKDIR /app
# node_modules from the worker's own lockfile. --ignore-scripts skips Playwright's browser download:
# the base image already ships the v1.62.1 browsers this pins.
RUN cp /src/apps/worker/package.json /src/apps/worker/package-lock.json ./ \
 && npm ci --omit=dev --ignore-scripts \
 && cp -r /src/apps/worker/src ./src \
 && mkdir -p /data \
 && chown -R pwuser:pwuser /data /app

USER pwuser
ENV NODE_ENV=production WORKER_DATA_DIR=/data WORKER_HOST=0.0.0.0
EXPOSE 8790
CMD ["node", "--experimental-strip-types", "src/index.ts"]
