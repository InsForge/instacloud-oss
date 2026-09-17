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
| `codex` | yes | yes | Same base, same ttyd asset. `codex --version` answers inside the arm64 image, so the CLI's platform-specific parts resolved |
| `dsh` | yes | yes | Same base. `bubblewrap` is in Debian for arm64, and the `@vscode/ripgrep` the harness bundles resolves its arm64 optional package (the Dockerfile asserts the binary exists) |
| `hermes` | yes | yes | Upstream's `v2026.8.27` index carries both; this image only adds an entrypoint |
| `n8n` | yes | yes | The official `n8nio/n8n:2.36.5` index carries both. Nothing is rebuilt here |
| `openclaw` | yes | yes | Upstream's index carries both; this image only adds an entrypoint |
| `pi` | yes | yes | Same base and ttyd asset as the other terminal templates |
| `whisper` | yes | **no** | Unproven, not incompatible. The machine this template was built on has no docker daemon, so the `--platform linux/arm64` build AGENTS.md asks for was never run. Both halves do publish for aarch64: torch serves `manylinux_2_28_aarch64` on its cpu index, and the ttyd aarch64 asset is already pinned in the Dockerfile. Run the two commands above and this becomes a one-line manifest change |

Every `arm64` **yes** above was checked by building the template for `linux/arm64` on an arm64
machine and starting the resulting image until it answered its own manifest healthcheck. Re-check a
row the same way rather than trusting it after a base image or upstream version moves. A **no**
rests on its own Evidence cell instead, which says whether the architecture was disproven or just
never proven: those are different, and only the second one is a row someone can clear.

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
| `openclaw` | `logo.svg` 4.6 KB | yes (vector) | fixed; includes a near-black `#050810` element | OpenClaw's mark |
| `9router` | `logo.png` 500x500 | yes (corner alpha 0) | fixed orange `#F34E21` | 9router's own mark, taken from the copy at `i.imgur.com/yjb5HvR.png`. Upstream's repo PNG (`images/9router.png`) is a 2940x2594 screenshot of the app, not this mark, so that copy is the only place the asset is available. Please do not "correct" this row to the repo URL |
| `whisper` | `meta.logo: none` | n/a | n/a | Upstream ships no mark. `openai/whisper` carries `approach.png`, which is a model architecture diagram, and `language-breakdown.svg`, which is a bar chart of WER per language: both are figures from the paper rather than a logo, and the rules here reject a hand-cut or redrawn one. The OpenAI corporate mark is the company's, not this project's, which is the difference between this row and the `codex` row above it (Codex has a product mark of its own). Declared `none` so the gallery draws a monogram |

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
