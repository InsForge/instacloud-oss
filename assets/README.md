# Deploy on InstaCloud button

The one-click deploy button, for a README that wants one. Same idea as `railway.com/button.svg`
or `sealos.io/Deploy-on-Sealos.svg`, and sized to sit beside them in the same row: 212x40 with a
6px radius, against Railway's 183x40 r6, Sealos' 185x42 r6.7 and Zeabur's 172x36 r8. It is wider
than those only because "Deploy on InstaCloud" is four characters longer than "Deploy on Railway".

![Deploy on InstaCloud](./deploy-button.svg)

## Use it

```markdown
[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/<code>)
```

Point the link at the gallery page, `https://instacloud.com/templates/<code>`, where `<code>` is
the template code (the folder name under `templates/`). It carries the description, the variable
table and the README, needs no account to read, and its own Deploy Now hands off to the console.

Two reasons it is the target rather than the console's deploy route, and the first is the one that
decides it:

- **The badge is a backlink.** These pages are the SEO surface and are prerendered as static HTML
  for exactly that. The console is behind the auth gate and is not indexed, so a badge pointing
  there spends the link on a page no crawler can read.
- **Whoever clicks it has usually never heard of us.** A badge sits in someone's repository, read
  by people who came for that project. The gallery page tells them what this is before it asks for
  anything. The console route asks them to sign in first and then mints a project as the first
  thing that ever happens in their account.

The console route, `https://console.instacloud.com/templates/<code>`, is still the one-click path
and is where Deploy Now goes: it mints a project named for the template and opens its deploy
configuration. Point a button straight at it only where the reader is already a customer, such as
inside our own product surfaces.

jsDelivr serves the file straight from this repository, which is the same CDN the template logos
go through. `@main` tracks this branch; pin a commit instead of `main` if you would rather the
button never change under you:

```markdown
[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@<sha>/assets/deploy-button.svg)](https://instacloud.com/templates/<code>)
```

## Light and dark

One file covers both themes. The palette is swapped by a `prefers-color-scheme` rule inside the
SVG, not by a `<picture>` element around it, because the template READMEs that carry this button
are also served by the gallery, whose markdown renderer parses no raw HTML on purpose. An SVG
referenced from `<img>` still evaluates that query against the viewer's own system setting, which
is how `templates/pi/logo.svg` already covers light and dark surfaces with one asset. A renderer
that ignores the query keeps the light palette, so the fallback is brand black.

The rule is load-bearing rather than a nicety: brand black on GitHub's dark README background
(`#0d1117`) is very nearly invisible, which is what the earlier 156x20 badge does today.

## In this repository

Every publishable template README carries the button under its title, and
`templates/scripts/lint.mjs` enforces that: a publishable template that omits it is rejected, the
href has to name that template's own code, and a draft cannot carry one at all, since its gallery
page does not exist until it publishes.

The lint asks the publisher what counts, through the same `findDeployButtons` the stripper uses,
so only a form publish would actually remove counts as the button. A fenced sample, an unlinked
image, a four-space indent or a neighbouring filename is a mention rather than a button, and gets
said so rather than passing as one. Copying the nearest template is how
`templates/AGENTS.md` says to start a new one, so a carried-over code in that href is the mistake
the check is really there for.

`templates/scripts/publish.mjs` strips the button on the way to the catalog. The gallery renders
the same README text on a page whose rail already carries a Deploy Now to the same console route,
so republished verbatim the button is a second, identical call to action sitting in the middle of
the prose. It earns its place on GitHub, where a template directory has no deploy affordance at
all. A fenced sample of the snippet, like the ones above, is left alone.

## Changing it

The label is outlined rather than set as `<text>`, which is what keeps the button the same width
on every machine and is what all three reference buttons do. Outlines cannot be edited by hand:
change the constants in [`make-deploy-button.py`](./make-deploy-button.py) and run it again. That
script documents its own dependencies, none of which are dependencies of this repository.

The face is Inter Medium, the brand face, under the SIL Open Font License 1.1, which is what makes
redistributing its outlines here fine. The cloud mark comes from the InstaCloud wordmark.
