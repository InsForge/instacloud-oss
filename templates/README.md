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
**managed database is different**: it has no URL, and its credentials arrive under `env.platform`
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
| `claude-code` | yes | yes | `node:24-bookworm-slim` is a multi-arch index, the ttyd 1.7.7 release ships an `aarch64` asset with its own pinned checksum, and the npm package is architecture-independent |
| `clickhouse` | yes | yes | Upstream's `26.8.11.7` index carries both, and the FROM pins that index digest rather than a child. The overlay is two `COPY`s and a `chmod`, so there is nothing architecture-specific to build. Weaker than the rows above by one step: the arm64 half rests on the workflow's buildx push and its index check, not on anyone having started the image on an arm64 machine |
| `codex` | yes | yes | Same base, same ttyd asset. `codex --version` answers inside the arm64 image, so the CLI's platform-specific parts resolved |
| `dsh` | yes | yes | Same base. `bubblewrap` is in Debian for arm64, and the `@vscode/ripgrep` the harness bundles resolves its arm64 optional package (the Dockerfile asserts the binary exists) |
| `hermes` | yes | yes | Upstream's `v2026.8.27` index carries both; this image only adds an entrypoint |
| `insforge` | yes | **no** | amd64 only by declaration rather than by upstream limit. `ghcr.io/insforge/postgres:v15.13.4` is a two-architecture index and PostgREST publishes an aarch64 asset, but the pin here is PostgREST's `linux-static-x86-64` build and the arm64 leg would compile the whole Node monorepo under QEMU. Adding the row means doing that on an arm64 machine, not editing this one |
| `laya` | yes | **no** | amd64 only by declaration rather than by upstream limit. The base and the CPU torch wheels both exist for aarch64, but the build bakes an 842 MB checkpoint by running a real prediction, and nobody has yet run that leg under QEMU or on an arm64 machine. Adding the row means doing that, not editing this one |
| `lev` | yes | **no** | amd64 only by declaration rather than by upstream limit, the same call `laya` made. The `python:3.12-slim-bookworm` base and the CPU torch wheels both exist for aarch64, but what this image is for is a 4B bf16 forward pass, and its kernels are exactly the part nobody has run on arm64. Adding the row means running one there, not editing this one |
| `n8n` | yes | yes | The official `n8nio/n8n:2.36.5` index carries both. Nothing is rebuilt here |
| `openclaw` | yes | yes | Upstream's index carries both; this image only adds an entrypoint |
| `openmuse` | yes | **no** | amd64 only by declaration rather than by upstream limit. Everything the image builds is JavaScript, and the `node:24-bookworm-slim` base carries both, so there is no architecture-specific step to fail. What has not happened is anyone running the build: a pnpm install of the whole workspace plus an Expo web export is the slowest leg in this registry, and nobody has put it through QEMU or an arm64 machine. Adding the row means doing that, not editing this one |
| `openmuse-browser` | yes | **no** | Companion image for `openmuse`, not a standalone template (declared draft). amd64 only by declaration: the `mcr.microsoft.com/playwright` base is multi-arch, but this is a roughly 2 GB image and nobody has run its build under QEMU or on an arm64 machine. Adding the row means doing that, not editing this one |
| `pi` | yes | yes | Same base and ttyd asset as the other terminal templates |
| `supabase` | yes | yes | Every upstream image the overlay copies from (Studio, postgres-meta, Storage API, imgproxy, Envoy, PostgREST, Realtime) and the GoTrue image it deploys directly is a two-architecture index. PostgREST's two halves differ: amd64 is a static binary with no shell, arm64 is Ubuntu with a dynamic one, so the overlay copies `/bin/postgrest` and installs `libpq5` and `libgmp10` for the arm64 build. The only compiled step is `npm rebuild fs-xattr` for glibc |
| `twenty` | yes | yes | Upstream's `v2.44.0` index carries both; this image only adds an entrypoint and two node scripts, none of it architecture-specific |
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
| `dsh` | `logo.svg` 2.0 KB | yes (vector) | fixed `#5786FE` | DeepSeek's mark, on DeepSeek's own project. The same file the delisted `deepseek-hermes` carried, where it was the weaker case: branding someone else's agent. Upstream's `BRAND_GUIDELINES.md` asks projects not to imply endorsement, which naming their own harness does not |
| `n8n` | `logo.svg` 1.6 KB | yes (vector) | fixed `#EA4B71` | n8n's brand mark |
| `clickhouse` | `logo.svg` 434 B | no, upstream's own plate (vector) | fixed `#FCFF74` bars on `#161616` | ClickHouse's app icon, `clickhouse.com/icon0.svg`, taken byte for byte (sha256 `97e3c3f3...`). The current brand yellow ships only on this plate: the transparent marks upstream publishes are the monochrome `static/img/clickhouse-logo-mark.svg` in `ClickHouse/clickhouse-docs`, which themes itself, and the retired orange-and-red `logo_without_text.svg`. 0.1.0 carried the monochrome mark and read as black bars on every gallery tile |
| `laya` | `logo.svg` 1.3 KB | yes (vector) | fixed `#2a78d6` | Laya's own mark, `assets/logo-mark.svg` in the original repository, NandhaKishorM/laya. Paths and circles, no `<text>`. The repo also ships `logo-mark-mono.svg` and a dark lockup, but no single file that adapts on its own |
| `openclaw` | `logo.svg` 4.6 KB | yes (vector) | fixed; includes a near-black `#050810` element | OpenClaw's mark |
| `insforge` | `logo.svg` 339 B | yes (vector) | fixed `#1a1a1a` and `#4a4a4a` | InsForge's own mark, `docs/favicon.svg` in the upstream repository at the v2.3.2 commit, taken byte for byte (sha256 `6819f8e1...`). Paths only, no `<text>`. The `assets/logo-*.svg` files are 1000x240 wordmark lockups, and cutting the mark out of one is the hand-cut the rules below forbid |
| `twenty` | `logo.svg` 2.6 KB | yes (corner alpha 0, rounded-rect clip) | fixed black plate | Twenty's own mark, `packages/twenty-website/public/images/core/logo.svg`. The black rounded square is the artwork, not a background: the glyph is white and cutting the plate away would leave nothing. No dark-mode variant is published |
| `9router` | `logo.png` 500x500 | yes (corner alpha 0) | fixed orange `#F34E21` | 9router's own mark, taken from the copy at `i.imgur.com/yjb5HvR.png`. Upstream's repo PNG (`images/9router.png`) is a 2940x2594 screenshot of the app, not this mark, so that copy is the only place the asset is available. Please do not "correct" this row to the repo URL |
| `lev` | `meta.logo: none` | n/a | n/a | lev **has** a mark, the `lev.` wordmark in near-black `#14181F` with a `#2A78D6` dot, and this row is worded to stop the repository concluding otherwise a second time. What upstream never does is publish it on its own: it appears only inside `hf/assets/hero.png` (3200x1120) and `hf/assets/social-card.png` (1200x630), both on an opaque `#FAFAF8` plate, and a recursive listing of both `Abhinavexists/lev` and `InterfazeAI/lev` returns no standalone file, no transparent copy and no favicon. `interfaze.ai` serves `interfaze_app_icon.svg`, which is Interfaze's mark and would label the model with the company, and no third-party listing carries a copy. Cropping the wordmark out of the banner is the hand-cut this section forbids, so the declaration is `none` and consumers fall back to a monogram. Please do not "correct" this row to say upstream ships no mark |
| `supabase` | `logo.svg` 1.1 KB | yes (vector) | fixed `#3ECF8E` green with a `#249361` gradient | Supabase's mark, `packages/common/assets/images/supabase-logo-icon.svg` in `supabase/supabase` at the `self-hosted/v0.8.2` commit, taken byte for byte. Paths and gradients, no `<text>` |
| `openmuse` | `logo.png` 256x256 | yes (corner alpha 0) | fixed | Upstream's own hand-drawn capybara, `apps/mobile/assets/capybara.png`, the assistant avatar the app shows on every surface and the only mark it ships. No vector copy, no favicon and no product site outside GitHub. The source is already a standalone 1254x1254 square on a transparent background, so this is the `hermes` and `9router` case, upstream's own app art taken whole and downscaled (to 256px, quantized to 24 KB), not the hand-cut the rules below forbid: nothing is cropped. Full-colour illustration, so it does not theme itself |
| `openmuse-browser` | `meta.logo: none` | n/a | n/a | Companion image for `openmuse`, not a standalone template (declared draft), so it has no gallery page and shows no mark. The `openmuse` row above carries OpenMuse's logo |
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
