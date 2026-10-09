# Template registry

One deployable app per folder: a manifest, an optional Dockerfile, a detail page, and a logo.
Templates published from here appear in the InstaCloud gallery and deploy with a single command.

**Contributions are welcome.** Adding a template is one pull request against this repo: no separate
asset PR, no coordination with any other repository. Read [AGENTS.md](AGENTS.md) for the rules CI
enforces, then copy the closest existing template as a starting point. General contribution setup
lives in the repo's [CONTRIBUTING.md](../CONTRIBUTING.md).

## Structure

```
templates/<code>/
  insta.template.yaml    # the manifest (source of truth); the folder name IS the code
  Dockerfile             # only when the template builds an overlay image. Wired by
                         # convention: templates-build-images.yml builds the folder and
                         # pushes the image the manifest then references as image:.
                         # Never a manifest build: key
  README.md              # the detail page (see AGENTS.md for the section order)
  logo.svg               # the template's mark; required for a publishable template.
                         # logo.png when upstream has no vector mark; meta.logo: none
                         # when it has no mark at all
scripts/
  lint.mjs               # the rules CI enforces (npm run lint)
  version-guard.mjs      # a changed template must bump its version (npm run version-guard)
  build-targets.mjs      # meta.architectures -> the image workflow's buildx platform list
  publish.mjs            # registry -> hosted catalog sync, run by CI on merge
  deploy.mjs             # local executor for trying a template by hand
```

A service may declare `volume: true` for a persistent disk mounted at `/data`, and `alwaysOn: true`
to keep the machine from being idle-stopped. Neither carries a number: CPU, memory and disk size
are the platform's, capped for the org's plan, so there is no `spec:` field and no `volume.size`.
Always-on bills continuously, so declare it only when the app must run without an inbound request
to wake it. n8n's schedule and polling triggers fire from inside the process, which is exactly that
case; a browser terminal is not, because opening it is itself the inbound request.

A value under `env.fixed` may interpolate another service's address as `${services.<name>.url}` or
`${services.<name>.host}`, resolved before anything deploys, including a service's own address. A
**managed database or a bucket is different**: it has no URL, and its credentials arrive under `env.platform`
as `${{services.<name>.<KEY>}}` — note the doubled braces. The two are not interchangeable, and
each is rejected in the other's place. See [AGENTS.md](AGENTS.md) for the field rules.

## Architectures

Every manifest declares `meta.architectures`, the image workflow builds exactly that list, and the
catalog serves it so `insta template deploy` can refuse a template this box cannot run before it
creates anything. The rules and the traps are in [AGENTS.md](AGENTS.md#architectures).

Where the record stands, and what each row rests on:

| Template | `amd64` | `arm64` | Evidence |
|---|---|---|---|
| `9router` | yes | yes | Upstream's `0.5.55` index carries both. The Dockerfile used to pin that index's amd64 CHILD digest, which is why this template could not cross-build; it now pins the index |
| `anythingllm` | yes | yes | Upstream's `1.17.0` index carries both, and the FROM pins that index digest rather than a child. The overlay is one `COPY`, one `chmod` and an `ENTRYPOINT`, so there is nothing architecture-specific to build. Same strength as the `clickhouse` row: the arm64 half rests on the workflow's buildx push and its index check, not on anyone having started the image on an arm64 machine |
| `claude-code` | yes | yes | `node:24-bookworm-slim` is a multi-arch index, the ttyd 1.7.7 release ships an `aarch64` asset with its own pinned checksum, and the npm package is architecture-independent |
| `clickhouse` | yes | yes | Upstream's `26.8.11.7` index carries both, and the FROM pins that index digest rather than a child. The overlay is two `COPY`s and a `chmod`, so there is nothing architecture-specific to build. Weaker than the rows above by one step: the arm64 half rests on the workflow's buildx push and its index check, not on anyone having started the image on an arm64 machine |
| `codex` | yes | yes | Same base, same ttyd asset. `codex --version` answers inside the arm64 image, so the CLI's platform-specific parts resolved |
| `documenso` | yes | yes | Upstream's `v2.20.0` index carries both, and the FROM pins that index digest rather than a child. The overlay is one `COPY --chmod` of a shell script, so there is nothing architecture-specific to build. The same strength as the `clickhouse` row: the arm64 half rests on the workflow's buildx push and its index check, not on anyone having started the image on an arm64 machine |
| `dsh` | yes | yes | Same base. `bubblewrap` is in Debian for arm64, and the `@vscode/ripgrep` the harness bundles resolves its arm64 optional package (the Dockerfile asserts the binary exists) |
| `gitea` | yes | **built, not run** | Upstream's `1.27.3` index carries amd64, arm64 and riscv64, and the overlay only removes a directory and copies a shell script, so nothing in it is architecture-specific. This workflow cross-built both legs and its own index check passed, but only the amd64 image has been STARTED and taken through the healthcheck: the template was authored on a box with no docker daemon. Half of the standard the sentence below this table sets. Run the arm64 leg before publishing |
| `hermes` | yes | yes | Upstream's `v2026.8.27` index carries both; this image only adds an entrypoint |
| `insforge` | yes | **no** | amd64 only by declaration rather than by upstream limit. `ghcr.io/insforge/postgres:v15.13.4` is a two-architecture index and PostgREST and Deno both publish aarch64 assets, but the pins here are PostgREST's `linux-static-x86-64` build and Deno's `x86_64-unknown-linux-gnu` one, and the arm64 leg would also compile the whole Node monorepo under QEMU. Adding the row means doing that on an arm64 machine, not editing this one |
| `laya` | yes | **no** | amd64 only by declaration rather than by upstream limit. The base and the CPU torch wheels both exist for aarch64, but the build bakes an 842 MB checkpoint by running a real prediction, and nobody has yet run that leg under QEMU or on an arm64 machine. Adding the row means doing that, not editing this one |
| `lev` | yes | **no** | amd64 only by declaration rather than by upstream limit, the same call `laya` made. The `python:3.12-slim-bookworm` base and the CPU torch wheels both exist for aarch64, but what this image is for is a 4B bf16 forward pass, and its kernels are exactly the part nobody has run on arm64. Adding the row means running one there, not editing this one |
| `miniflux` | yes | yes | The official `miniflux/miniflux:2.3.3` index carries both, alongside arm/v6, arm/v7 and riscv64. Nothing is rebuilt here, so like `n8n` the row rests on upstream's published index rather than a local arm64 run |
| `n8n` | yes | yes | The official `n8nio/n8n:2.36.5` index carries both. Nothing is rebuilt here |
| `open-slide` | yes | **no** | amd64 only by declaration rather than by upstream limit. The `node:24-bookworm-slim` base carries both and everything installed is npm packages, but the install resolves the per-platform native bindings Vite 8 (rolldown) and Tailwind 4 (oxide) ship as optional dependencies, and nobody has run it under QEMU or on an arm64 machine. Adding the row means doing that, not editing this one |
| `open-webui` | yes | yes | The official `ghcr.io/open-webui/open-webui:v0.11.4` index carries both, read off the registry: an OCI index with one `amd64` and one `arm64` manifest. Nothing is rebuilt here, so like `n8n` and `miniflux` the row rests on upstream's published index. One step weaker than the rows started on an arm64 machine: only the amd64 half has been deployed and used |
| `openbot` | yes | **no** | amd64 only by upstream's limit. The release workflow builds `ghcr.io/copilotkit/openbot` on `ubuntu-latest` with no `platforms:`, so the published `v0.0.15` index carries exactly one manifest, `linux/amd64`. (The per-framework agent images beside it are two-arch; this one is not.) Nothing in this overlay could add the other half, so the row says one and the Dockerfile refuses any other `dpkg --print-architecture` rather than building something that cannot run |
| `openclaw` | yes | yes | Upstream's index carries both; this image only adds an entrypoint |
| `opendots` | yes | **no** | amd64 only by declaration rather than by upstream limit. Everything the image builds is JavaScript, and the `node:24-bookworm-slim` base carries both, so there is no architecture-specific step to fail. What has not happened is anyone running the build: `npm ci` of a Vite 8 and TipTap tree resolves per-platform native bindings as optional dependencies, the same reason `open-slide` says amd64, and nobody has put it through QEMU or an arm64 machine. Adding the row means doing that, not editing this one |
| `openmuse` | yes | **no** | amd64 only by declaration rather than by upstream limit. Everything the image builds is JavaScript, and the `node:24-bookworm-slim` base carries both, so there is no architecture-specific step to fail. What has not happened is anyone running the build: a pnpm install of the whole workspace plus an Expo web export is the slowest leg in this registry, and nobody has put it through QEMU or an arm64 machine. Adding the row means doing that, not editing this one |
| `openmuse-browser` | yes | **no** | Companion image for `openmuse`, not a standalone template (declared draft). amd64 only by declaration: the `mcr.microsoft.com/playwright` base is multi-arch, but this is a roughly 2 GB image and nobody has run its build under QEMU or on an arm64 machine. Adding the row means doing that, not editing this one |
| `paperclip` | yes | yes | The official `ghcr.io/paperclipai/paperclip:2026.1005.0` index carries both, read off the registry: it is an OCI index with an `arm64` and an `amd64` manifest. Nothing is rebuilt here. One step weaker than the rows started on an arm64 machine: only the amd64 half has been deployed and used |
| `pi` | yes | yes | Same base and ttyd asset as the other terminal templates |
| `supabase` | yes | yes | Every upstream image the overlay copies from (Studio, postgres-meta, Storage API, imgproxy, Envoy, PostgREST, Realtime) and the GoTrue image it deploys directly is a two-architecture index. PostgREST's two halves differ: amd64 is a static binary with no shell, arm64 is Ubuntu with a dynamic one, so the overlay copies `/bin/postgrest` and installs `libpq5` and `libgmp10` for the arm64 build. The only compiled step is `npm rebuild fs-xattr` for glibc |
| `twenty` | yes | yes | Upstream's `v2.44.0` index carries both; this image only adds an entrypoint and two node scripts, none of it architecture-specific |
| `umami` | yes | yes | Upstream's `3.4.0` index carries both, and the FROM pins that index digest rather than a child. The overlay adds two scripts and a `pnpm add` of `pg` and `bcryptjs`, both pure JavaScript with no install script, so nothing in it is architecture-specific. The same strength as the `clickhouse` row: the arm64 half rests on the workflow's buildx push and its index check, not on anyone having started the image on an arm64 machine |
| `whisper-turbo` | yes | **no** | `debian:bookworm-slim` carries both, but upstream's `make server` target compiles `-DWHISPER_X86` against the AVX2/AVX-512/VNNI kernels in `src/x86`. The generic C fallback in the tree is not wired into that target, so there is nothing to build for arm64 and the row says so rather than shipping a broken index |

Every row above except `clickhouse`, which says what it rests on instead, was checked by building
the template for `linux/arm64` on an arm64 machine and starting the resulting image until it
answered its own manifest healthcheck. Re-check a row the same way rather than trusting it after a
base image or upstream version moves. The `no` rows are the other half of the same rule: an upstream that genuinely builds for one architecture declares
one, and a user on the other is refused before the deploy creates anything.

## Logo attribution

Each mark belongs to its upstream project and is committed here, so contributing a template stays a
single pull request. Transparency below is measured from corner-pixel alpha rather than colour type,
because an RGBA file can still be fully opaque.

| Template | File | Transparent | Dark mode | Source |
|---|---|---|---|---|
| `claude-code` | `logo.svg` 2.5 KB | yes (vector) | fixed `#D97757` | Anthropic's Claude Code mark |
| `codex` | `logo.svg` 3.7 KB | yes (vector) | fixed (blue gradient, white glyph) | OpenAI's Codex mark |
| `pi` | `logo.svg` 618 B | yes (vector) | **adapts** via `prefers-color-scheme` | <https://pi.dev/logo-auto.svg> |
| `hermes` | `logo.png` 512x512 | yes (corner alpha 0) | fixed light plate | Upstream's own app icon, `apps/desktop/assets/icon.png` at 1024x1024, downscaled. This row used to name the NousResearch GitHub org avatar and claim upstream published no transparent mark; that icon disproves it. No vector option: upstream's only SVG is a bare `⚕` glyph in the default font, which the rules below reject. Stored greyscale+alpha, halving the bytes for a max difference of 3/255 on a single pixel. The white plate is part of the artwork, not a background: the character's face is the plate showing through, so cutting it out would erase the face |
| `documenso` | `logo.png` 320x320, 8.0 KB | yes (RGBA, corner alpha 0) | fixed black | Documenso's own mark, `packages/assets/logo_icon.png` in the upstream repository at `v2.20.0`, taken byte for byte (sha256 `7b82705c...`). No standalone vector: the same mark exists as path data inside `apps/remix/app/components/general/branding-logo.tsx`, but only as the left third of a 2248x320 wordmark painted in `currentColor`, so a square SVG would be both a hand-cut and the self-theming case the rules below reject. `documenso.com` serves no `favicon.svg` or `logo.svg` |
| `dsh` | `logo.svg` 2.0 KB | yes (vector) | fixed `#5786FE` | DeepSeek's mark, on DeepSeek's own project. The same file the delisted `deepseek-hermes` carried, where it was the weaker case: branding someone else's agent. Upstream's `BRAND_GUIDELINES.md` asks projects not to imply endorsement, which naming their own harness does not |
| `n8n` | `logo.svg` 1.6 KB | yes (vector) | fixed `#EA4B71` | n8n's brand mark |
| `clickhouse` | `logo.svg` 434 B | no, upstream's own plate (vector) | fixed `#FCFF74` bars on `#161616` | ClickHouse's app icon, `clickhouse.com/icon0.svg`, taken byte for byte (sha256 `97e3c3f3...`). The current brand yellow ships only on this plate: the transparent marks upstream publishes are the monochrome `static/img/clickhouse-logo-mark.svg` in `ClickHouse/clickhouse-docs`, which themes itself, and the retired orange-and-red `logo_without_text.svg`. 0.1.0 carried the monochrome mark and read as black bars on every gallery tile |
| `laya` | `logo.svg` 1.3 KB | yes (vector) | fixed `#2a78d6` | Laya's own mark, `assets/logo-mark.svg` in the original repository, NandhaKishorM/laya. Paths and circles, no `<text>`. The repo also ships `logo-mark-mono.svg` and a dark lockup, but no single file that adapts on its own |
| `openbot` | `logo.png` 256x256 | yes (corner alpha 0) | fixed (pink-to-blue gradient orb) | OpenBot's own app icon, `desktop/src-tauri/icons/128x128@2x.png`, taken byte for byte. No vector option: upstream's only SVGs are the two 48 KB architecture diagrams in `assets/`, which are illustrations rather than a mark. The icons' own README says the set is exported from the `.orb` artwork in the desktop stylesheet with nothing redrawn, and names `icon.png` the transparent 1024x1024 master; this is the 256 px export of it, which fits the size rule where the master does not |
| `openclaw` | `logo.svg` 4.6 KB | yes (vector) | fixed; includes a near-black `#050810` element | OpenClaw's mark |
| `insforge` | `logo.png` 300x300, 17 KB | no, upstream's own plate | fixed white-to-grey mark on black | InsForge's favicon, `docs/favicon.png` in the upstream repository at the v2.3.2 commit, taken byte for byte (sha256 `e831c2ea...`). The same file is `frontend/public/favicon.ico` there and what `insforge.dev/favicon.ico` serves, so it is the mark upstream actually shows. The transparent `docs/favicon.svg` is a flat dark-grey monochrome, the case the rules below steer away from, and the `assets/logo-*.svg` files are 1000x240 wordmark lockups that only a hand-cut could reduce to the mark |
| `miniflux` | `logo.svg` 1.0 KB | **no** (an opaque `<rect>` is part of the artwork) | **adapts** via `prefers-color-scheme` | Upstream's own app icon, `internal/ui/static/bin/icon.svg`, committed verbatim. The mark is a wordless glyph on a filled plate and the plate is drawn by the file, not added here: the same `<style>` block that flips the glyph between `#000` and `#fff` flips the plate the other way, so cutting the rect out would leave a glyph that turns invisible on half the surfaces it lands on. Upstream publishes no transparent variant; miniflux.app carries no mark at all. Per AGENTS.md the card puts a neutral tile behind it rather than anyone hand-cutting one |
| `twenty` | `logo.svg` 2.6 KB | yes (corner alpha 0, rounded-rect clip) | fixed black plate | Twenty's own mark, `packages/twenty-website/public/images/core/logo.svg`. The black rounded square is the artwork, not a background: the glyph is white and cutting the plate away would leave nothing. No dark-mode variant is published |
| `gitea` | `logo.svg` 2.6 KB | yes (vector) | fixed `#609926`, plus a white `#FFFFFF` teabag element | Gitea's own mark, `assets/logo.svg` in `go-gitea/gitea`. Paths only, no `<text>`. The white element is the teabag inside the cup and is part of the artwork: on a white card it reads as the cutout it is drawn as, which is how upstream shows it too |
| `9router` | `logo.png` 500x500 | yes (corner alpha 0) | fixed orange `#F34E21` | 9router's own mark, taken from the copy at `i.imgur.com/yjb5HvR.png`. Upstream's repo PNG (`images/9router.png`) is a 2940x2594 screenshot of the app, not this mark, so that copy is the only place the asset is available. Please do not "correct" this row to the repo URL |
| `lev` | `meta.logo: none` | n/a | n/a | lev **has** a mark, the `lev.` wordmark in near-black `#14181F` with a `#2A78D6` dot, and this row is worded to stop the repository concluding otherwise a second time. What upstream never does is publish it on its own: it appears only inside `hf/assets/hero.png` (3200x1120) and `hf/assets/social-card.png` (1200x630), both on an opaque `#FAFAF8` plate, and a recursive listing of both `Abhinavexists/lev` and `InterfazeAI/lev` returns no standalone file, no transparent copy and no favicon. `interfaze.ai` serves `interfaze_app_icon.svg`, which is Interfaze's mark and would label the model with the company, and no third-party listing carries a copy. Cropping the wordmark out of the banner is the hand-cut this section forbids, so the declaration is `none` and consumers fall back to a monogram. Please do not "correct" this row to say upstream ships no mark |
| `supabase` | `logo.svg` 1.1 KB | yes (vector) | fixed `#3ECF8E` green with a `#249361` gradient | Supabase's mark, `packages/common/assets/images/supabase-logo-icon.svg` in `supabase/supabase` at the `self-hosted/v0.8.2` commit, taken byte for byte. Paths and gradients, no `<text>` |
| `openmuse` | `logo.png` 256x256 | yes (corner alpha 0) | fixed | Upstream's own hand-drawn capybara, `apps/mobile/assets/capybara.png`, the assistant avatar the app shows on every surface and the only mark it ships. No vector copy, no favicon and no product site outside GitHub. The source is already a standalone 1254x1254 square on a transparent background, so this is the `hermes` and `9router` case, upstream's own app art taken whole and downscaled (to 256px, quantized to 24 KB), not the hand-cut the rules below forbid: nothing is cropped. Full-colour illustration, so it does not theme itself |
| `open-slide` | `logo.png` 128x128 | yes (corner alpha 0, rounded-rect clip) | fixed dark plate | open-slide's own app icon, `packages/core/src/app/assets/open-slide.png` in the upstream repo, taken byte for byte. It is the mark the app draws in its own sidebar and the one `open-slide.dev` serves in its header, and upstream publishes no vector copy: the 512x512 `apps/web/public/open-slide.png` is the same artwork at 236 KB, over the size this section asks for. The dark rounded square is the artwork, not a background: the chevron is a silver gradient that would be invisible without it |
| `paperclip` | `logo.png` 512x512, 29 KB | no, upstream's own plate (RGB, no alpha channel) | fixed light-grey clip on near-black | Paperclip's own app icon, `ui/public/android-chrome-512x512.png` in the upstream repository at the `v2026.1005.0` tag, taken byte for byte (sha256 `e01eeadd...`). No usable vector option: upstream's only SVG mark, `ui/public/favicon.svg`, repaints its stroke through a `prefers-color-scheme` rule, which the rules below reject, and stripping that rule would be the hand-cut they also forbid. The plate is part of the shipped icon, so this is the `clickhouse` and `insforge` case |
| `openmuse-browser` | `meta.logo: none` | n/a | n/a | Companion image for `openmuse`, not a standalone template (declared draft), so it has no gallery page and shows no mark. The `openmuse` row above carries OpenMuse's logo |
| `anythingllm` | `logo.svg` 1.3 KB | yes (vector) | fixed `#0F172A` | AnythingLLM's own brand mark, `anythingllm.com/images/brand/logo-mark.svg`, taken byte for byte. A single path, no `<text>` and no `prefers-color-scheme` rule. The repository itself ships only `images/wordmark.png` and the light/dark pair `frontend/public/anything-llm-{light,dark}.png`, which are lockups rather than the mark, so the product site is where the standalone file lives |
| `umami` | `logo.svg` 413 B | yes (vector) | fixed `#000` stroke on a `#fff` bowl | Umami's own mark, the SVG inlined in the header of <https://umami.is>, taken with its colours as the site serves them and only the `width`/`height` attributes dropped so it scales to the tile. The copy in the repository (`src/assets/logo.svg`) is the same geometry painted in `currentColor`, which is the self-theming case the rules below reject: inside an `<img>` it resolves against the SVG's own canvas, so it inverts in Firefox's dark mode. Nothing is redrawn; the two files differ only in where the paint comes from |
| `open-webui` | `logo.png` 512x512, 21 KB | yes (corner alpha 0), but the artwork carries a white plate | fixed black `01` glyph on a white rounded square | Open WebUI's own favicon, `static/favicon.png` in the upstream repository, taken byte for byte (sha256 `5698a3e3...`). No usable vector option: the `static/static/favicon.svg` beside it is this same PNG base64'd inside an `<image>` element with a `prefers-color-scheme` block appended, so it is neither a vector nor allowed by the rules below. The white rounded square is part of the shipped icon, the `clickhouse` and `paperclip` case, and the glyph is black, so it still reads on the gallery's light tile. Upstream's `LICENSE` forbids altering Open WebUI branding, which is a second reason this file is copied rather than cut down |
| `opendots` | `logo.svg` 416 B | no, upstream's own plate (vector) | fixed `#778bed` dot face on an `#e8edff` plate | Upstream's own favicon, `public/favicon.svg`, taken byte for byte. It is the only mark the repository ships and the one the app shows in the tab; there is no product site outside GitHub, and the `public/dots/*.png` files beside it are the four Dot avatars rather than a mark. Paths and ellipses, no `<text>` and no `prefers-color-scheme` rule. The pale rounded square is part of the artwork, the same `clickhouse` and `twenty` case: the dot's face is drawn in two blues that read as a smudge without it |
| `whisper-turbo` | `meta.logo: none` | n/a | n/a | Upstream has no mark at all: no logo or icon in the repository, no favicon, and no product site outside GitHub. Declared `none` so consumers fall back to a monogram, rather than drawing one, which the rules below forbid. Revisit if upstream ever publishes one |

Logos are served to the gallery from jsDelivr, pinned to the commit that published the template:
`https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@<sha>/templates/<code>/logo.svg`. That URL is
immutable per published version and cached at the edge, so a gallery loading eight of them costs
nothing.

## Try a template locally

```bash
npm install
INSTA_LINK_DIR=<a dir linked to your project> npm run deploy -- claude-code --branch my-branch \
  --set ADMIN_USERNAME=you --set ADMIN_PASSWORD=<pick one>
# pass variables with --set KEY=value. Anything you omit resolves the way the
# platform resolves it: a declared generator mints a value, otherwise the
# manifest's default applies, and only a variable with neither stops the run.
# The terminal templates declare neither for their credentials on purpose, so
# those two --set flags are not optional -- omit one and the run stops at step 5
# naming it, exactly as the deploy form refuses to submit with the field empty.
# The summary at the end names every value you did not supply yourself.
```

`deploy.mjs` drives the standard `insta` CLI end to end: create services, run generators, write
variables (including the `template@version` attribution stamp), deploy, poll until healthy, print
the URLs. It is a convenience for authoring and debugging a template by hand; the hosted platform
runs the same steps server-side.

## Rules

See [AGENTS.md](AGENTS.md). CI runs `npm run lint` and the version guard on every pull request.
