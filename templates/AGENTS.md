# Contributing a template

For humans and agents alike. One template per folder under `templates/<code>/`, and the folder name
IS the template code. Copying the closest existing template is the fastest way to start.

## Files

- `insta.template.yaml`: the manifest, and the source of truth. Required.
- `Dockerfile`: only when the template builds an overlay image. The workspace templates
  (`claude-code`, `codex`, `pi`) do; a template that references an official upstream image, like
  `n8n`, must not rebuild it. It is wired **by convention**: `templates-build-images.yml` builds
  `templates/<code>/` and pushes `ghcr.io/insforge/insta-oss/templates/<code>:<version>`, which the
  manifest then references as `image:`. Never add a `build:` key to the manifest. The catalog
  rejects a service carrying both `image:` and `build:`, and `image:` is the one that deploys.
- `README.md`: the detail page shown in the gallery. Required, and factual: leave a fact out rather
  than guess it. Follow the section order the existing templates use, which is Overview, what you
  get by hosting it, what you need before deploying, Configuration (a row per variable saying what
  it does and where the value comes from), After deploy (how to actually start using it), and
  Links (upstream, the image or package, the license). A draft template opens with a note saying
  why it is draft.
- The **deploy button**, in its own paragraph under the title and tagline, for every publishable
  template: `[![Deploy on InstaCloud](<cdn>/assets/deploy-button.svg)](https://instacloud.com/templates/<code>)`.
  CI rejects a publishable template that omits it, checks that the href names this template's own
  code, and rejects one on a draft, whose gallery page does not exist until it publishes. Since
  copying the nearest template is the fastest way to start, a code carried over from the one you
  copied is the mistake that check exists for. The publish step removes the line on the way to
  the catalog, so the gallery does not show a second copy of the call to action its own rail
  already carries. The asset and the snippet live in [assets/README.md](../assets/README.md).
- `logo.svg`: the template's mark, and a **hard requirement for a publishable template**. CI
  rejects a non-draft template without one. Declare the path as `meta.logo: ./logo.svg` and CI
  checks that it resolves. Details and the reasoning are under [Logos](#logos).
- Screenshots and any other README assets: keep them in your own template directory and reference
  them with **relative** paths, such as `![](./screenshot.png)`. The README is published to the
  gallery as text, where a relative path would resolve against the gallery's own origin and 404, so
  the publish step rewrites relative targets into absolute URLs pinned to the publishing commit:
  images through the same CDN as the logo, and links to the GitHub page a reader can browse. Two
  rules follow, both enforced by CI: a referenced asset must exist, and an image may not point
  outside its own template directory, because nothing outside it is the template's to ship.

## Hard rules (CI rejects violations)

1. Image references pin a specific tag or digest. `latest` or tagless is rejected, because an
   image that floats on `latest` silently changes under a deployed instance on every restart.
2. Every required variable without a generator has a `description` saying what it is and where to
   get it.
3. `code`, `version` (semver), `maintainer`, `upstream.pinned` and `meta.category` are mandatory.
4. A changed template must bump its `version`. The canonical image tag is derived from it, so
   editing a template without bumping would overwrite an image that published instances pull.
5. A service may not carry both `image:` and `build:`.
6. `constraints[].oneOf` and `allOf` may only name variables the manifest declares.
7. A manifest never sizes a service. There is no `spec:`, and `volume:` is the boolean `true`, not
   a size. CPU, memory and disk are the platform's to choose and are capped for the org's plan, so
   a number here could only drift from it: every template once carried `size: 1` because that was
   the free cap the day it was written. `npm run lint` refuses both, and so does publish.
8. Never commit `index.json`. CI generates it.
9. `meta.architectures` is mandatory, drafts included: a non-empty list of `amd64`, `arm64`, or
   both. See [Architectures](#architectures).
10. A `${...}` inside an `env.fixed` value may only be `${services.<name>.url}` or
   `${services.<name>.host}`, naming a service the manifest declares that is not a managed
   database and not a worker. A managed database has no address: its credentials belong under
   `env.platform` as `${{services.<name>.<KEY>}}`, with doubled braces, and putting that form in
   `fixed` is rejected. A worker has no address either, see rule 11. So is a generator ref, even a
   declared one: composed into a fixed string it is stored only as the final value, so a retry
   could not recover it and would silently rotate the secret. Declare the variable under
   `env.generated` instead. `npm run lint` mirrors the platform's check.
11. A `type: worker` service is portless. The platform runs it with no routed port: nothing is
   routed to it, nothing probes it, and it stays always-on because no request could wake it. So
   it carries no `port`, no `healthcheck` and no `alwaysOn: false`, and no other service may
   reference its `url` or `host`. Its health is the machine's state (started and not crashed). Use
   it for queue consumers, schedulers and bots that only make outbound connections, and give it a
   `volume: true` if it keeps state, since a restart clears the root filesystem. `npm run lint`
   refuses the four shapes, and so does publish.
12. A service is `web`, `worker`, or one of the managed datastores `postgres`, `redis`, `mysql` and
   `mongodb`. A managed datastore is declared **bare**, as `{ type: redis }` and nothing else: the
   platform owns its image, port, version, sizing and credentials, and a manifest that named any of
   them could only drift from the platform's catalog. Consume it through `env.platform` with
   `${{services.<name>.<KEY>}}`, never through `${services.<name>.url}`, which is refused. Each
   managed datastore is born with its own data volume at the deployer's plan cap, so a template that
   declares two of them costs two volumes. `npm run lint` warns above two.
   Declaring `redis`, `mysql` or `mongodb` makes a template cloud-only today. This repository's own
   self-hosted runtime (`src/`) still parses only `web`, `worker` and `postgres`, so it skips a
   template that declares one of the other three, logging a warning, until it gains support for
   them. `npm run lint` warns on this too and never fails the run over it.

## Architectures

`meta.architectures` names the CPU architectures your template's deployable image is published
for, in OCI naming: `[amd64, arm64]`, or one of the two. It is not decoration. Three things read
it, so a wrong answer is worse than no template at all:

- `templates-build-images.yml` derives its buildx `platforms` from it and, after pushing, checks
  the pushed index against it. Declaring `arm64` for an image that cannot cross-build turns the
  build red.
- The catalog serves it, and the dashboard greys out a template this box cannot run.
- `insta template deploy` refuses the pair before it creates a single service. Without the field
  the deploy runs, creates the services and the variables, and only then fails on the pull with
  docker's `no matching manifest for linux/arm64/v8`, leaving half a template behind.

**Prove it before you declare it.** From the repository root:

```bash
docker buildx build --platform linux/arm64 templates/<code>          # it builds
docker buildx build --platform linux/arm64 --load -t probe templates/<code>
docker run --rm probe <your app's version command>                   # and it runs
```

Two traps, both real, both found in this registry:

- **Pin the index digest, not a child's.** `FROM upstream:1.2@sha256:...` is only multi-arch if
  that digest is the OCI index. Take it from the top-level `Digest:` line of
  `docker buildx imagetools inspect upstream:1.2`, never from one of the `Manifests:` rows. A
  child digest resolves to that one platform whatever `--platform` says, which is exactly how
  `9router` shipped an amd64-only image while every other pin was fine.
- **A per-architecture download needs a per-architecture checksum.** The ttyd templates switch on
  `dpkg --print-architecture` and verify a different SHA-256 for each. A single pinned checksum
  cannot be right for both.

If an upstream genuinely publishes only one architecture, declare only that one. That is an
honest template: the catalog says so, the workflow builds only what exists, and a user on the
other architecture is told before they deploy rather than after. Do not declare both and hope.

## Logos

A template directory owns everything about itself, so contributing one is a single pull request
here rather than a manifest PR plus an asset PR somewhere else. Prefer SVG. `logo.png` is fine when
upstream has no vector mark: keep it square, roughly 128 to 512 px, and under about 100 KB.

- Use the upstream project's **own** mark, never a redrawn one.
- Check the project's **product site**, not just its repository. A repo often carries only a banner
  or a README screenshot while the site serves a real mark. `pi.dev/logo-auto.svg` is where pi's
  came from, after its repository appeared to have none.
- A mark that adapts to dark mode is strictly better than one that does not, and worth asking for.
  pi's carries its own `@media (prefers-color-scheme: dark)` rule, so one file works on light and
  dark surfaces alike.
- Reject a `<text>`-based mark even when it is upstream's own favicon. A glyph in `system-ui`
  renders differently on every machine, and two of the upstreams here ship exactly that.
- The asset must have **real transparency**. Check the corner pixels' alpha rather than the colour
  type, because an RGBA file can still be fully opaque. A mark baked onto a solid background reads
  as a coloured tile and fights whichever theme it was not drawn for.
- Where upstream publishes nothing transparent, say so in the attribution table in
  [README.md](README.md) and let the card put a neutral tile behind it. Do not hand-cut one.
- If upstream has no mark at all, declare `meta.logo: none`. Consumers fall back to a monogram.
  That declaration gets reviewed; a missing file does not.

Why the file lives in the repo instead of a URL in the manifest: a gallery that lets an author name
any URL ends up pulling images from image hosts and personal CDNs, which rot silently, arrive in
unpredictable sizes, and send every visitor's browser to a third party. Keeping the file here means
the catalog holds only a reference, and it is served from a CDN pinned to the publishing commit.

## Conventions

- Volumes mount at `/data`, which the platform fixes. Point the app's data directory there with its
  own env var (`HERMES_HOME`, `N8N_USER_FOLDER`, `HOME`) and check upstream docs for the right one.
- Fair-code upstreams such as n8n: reference the official image, and never rebuild or rebrand it.
- A template that exposes a terminal MUST require an access credential (for ttyd, the `-c` flag).
- Categories are `ai-agent`, `llm` and `automation`. Propose a new one in your PR rather than
  reaching for `other`.
- `meta.draft: true` keeps a template out of the gallery while it is unfinished. Drafts are exempt
  from the logo and version-bump rules, because they publish nothing.
- Everything in this tree is **English**, comments included. A comment only some contributors can
  read is a comment that rots.
- User-facing strings are `meta.name`, `meta.tagline`, every variable `description`, and the README.
  They render in the public gallery and in the deploy form. Keep a tagline short: a noun phrase
  saying what the thing is, roughly 6 to 10 words, no trailing period, and never restating the
  template name that the card already shows.
- `upstream.license` carries the SPDX identifier of the software being packaged. Use the
  `LicenseRef-` form when it is not an OSS license, such as a vendor's commercial terms, and read
  the value off the upstream repository or package rather than assuming it.
- No em dashes in this repo, matching the rest of the docs.

## Flow

Open a pull request against `main`. CI runs the lint and the version guard; a reviewer merges; the
publish workflow syncs the change to the hosted catalog. Deployed instances never auto-update, so
bumping `version` is what surfaces an "update available" marker to someone already running it.
