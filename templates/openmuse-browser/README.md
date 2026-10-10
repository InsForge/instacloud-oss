# OpenMuse Browser Worker

> **Companion image, not a standalone template.** This directory exists to build the Chromium worker
> image that the [`openmuse`](../openmuse) template runs as its browser service. It is declared
> `draft`, so it never appears in the gallery on its own. Deployed alone it is an authenticated HTTP
> endpoint with no UI.

## What it is

OpenMuse's browser worker is [`apps/worker`](https://github.com/CopilotKit/OpenMuse/tree/main/apps/worker)
in the upstream monorepo: a private [Playwright](https://playwright.dev) Chromium service the OpenMuse
API drives for page reads, screenshots and Take control. Upstream publishes no image for it and
builds it from source (its `render.yaml` runs it as its own `openmuse-browser` service alongside the
API), so this directory builds the same thing from the pinned OpenMuse commit.

A template directory builds exactly one image, so the worker cannot live inside the `openmuse`
directory next to the API image. It is built here instead, and the `openmuse` manifest references the
image this publishes as a second service.

## Interface

- Listens on `8790`. `GET /health` is unauthenticated (the platform's health gate); every other
  route needs `Authorization: Bearer $WORKER_TOKEN`.
- `WORKER_TOKEN` must be at least 32 characters. When this runs as part of `openmuse`, the token is
  minted once there and handed to both services.

## Links

- Upstream: <https://github.com/CopilotKit/OpenMuse>, built from commit
  `9ec439fbaa878197d9d44c2aa982cca55676dd68`.
- Image: `ghcr.io/insforge/insta-oss/templates/openmuse-browser`, built from `./Dockerfile`.
- License: MIT (upstream `CopilotKit/OpenMuse`).
