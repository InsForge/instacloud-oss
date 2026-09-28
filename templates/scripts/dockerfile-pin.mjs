// The upstream version is written twice for every template we build ourselves: as
// `upstream.pinned` (or `upstream.commit`) in the manifest, and again in the Dockerfile that
// installs or clones it. Until this rule existed nothing checked they agreed, so editing one and
// not the other built the image from one version while the catalog advertised another, and neither
// lint nor the build nor publish would say a word.
//
// The check is a SUBSTRING match and deliberately knows nothing about what a pin means. Seven
// shapes live in the registry today: plain semver (0.5.55), a prerelease (0.1.1-rc.2), a v-prefixed
// date (v2026.8.27), a floating tag with a digest (latest@sha256:...), and a bare commit sha. Any
// rule that parsed them would be wrong about some of them, and being wrong here means either a
// false alarm on every pull request or a check that quietly passes the thing it exists to catch.
//
// Either pin counts, because laya legitimately has a `pinned` the Dockerfile never names: it pins
// the upstream PyPI release 0.3.4 for the catalog to display, while the image clones a commit,
// since `pip install laya==0.3.4` does not carry the deploy/app.py the image runs.

/**
 * `image:tag@sha256:...`, `image:tag`, or `image`, split into the three parts a FROM can carry.
 *
 * The colon has to be after the last slash to be a tag separator, or a registry written with a
 * port (`host:5000/x/y`) would read its own port as the tag.
 */
function splitRef(ref) {
  const [head, digest] = String(ref).split('@');
  const slash = head.lastIndexOf('/');
  const colon = head.lastIndexOf(':');
  const tagged = colon > slash;
  return { image: tagged ? head.slice(0, colon) : head, tag: tagged ? head.slice(colon + 1) : '', digest: digest ?? '' };
}

/**
 * A manifest pin, which is NOT a ref: it is the part a FROM puts after the image, so `0.5.55` or
 * `latest@sha256:...`. Parsing it as a ref reads `0.5.55` as an image name with no tag, which is
 * how the first version of this compared an empty string against every tag and passed nothing.
 */
const splitPin = (pin) => {
  const [tag, digest] = String(pin ?? '').split('@');
  return { tag, digest: digest ?? '' };
};

/**
 * The instructions a Dockerfile actually carries: comments dropped, continuations joined.
 *
 * Comments first, then continuations, which is the order docker itself uses. Both matter and each
 * was a way past this check. A comment counted as naming the pin, so
 * `# previously pinned at 2.1.235` over `RUN npm install -g x@2.0.0` passed while the image built
 * a different version than the manifest advertised. And `FROM --platform=... \` continued on the
 * next line is one instruction to docker and was two to a scanner reading physical lines, so the
 * reference that actually builds could sit somewhere this never looked.
 */
const instructions = (dockerfile) => String(dockerfile ?? '')
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n')
  .replace(/\\[ \t]*\r?\n[ \t]*/g, ' ');

/**
 * Does `pin` appear in `text` as a value rather than as part of a longer one?
 *
 * Plain containment reads `1.2.3` as present in `1.2.30`, so a template pinned one release behind
 * its Dockerfile would pass. A digit or a dot on either side means the match is the middle of
 * something else; every real separator here is `@`, `:`, `=`, `v` or whitespace.
 */
function names(text, pin) {
  for (let i = text.indexOf(pin); i >= 0; i = text.indexOf(pin, i + 1)) {
    const before = text[i - 1] ?? '';
    const after = text[i + pin.length] ?? '';
    if (!/[0-9.]/.test(before) && !/[0-9.]/.test(after)) return true;
  }
  return false;
}

/**
 * Where a template builds on the upstream's own image, does its FROM still name the pinned tag?
 *
 * Three templates do this, and all three pin twice over: `FROM <image>:<tag>@sha256:<digest>`. The
 * substring rule above would catch a manifest that moved without the FROM, but only because the old
 * value happens to vanish. This says it outright, and it is the half of the problem that can be
 * checked without a network: whether the digest still belongs to that tag is a question only the
 * registry can answer, and check-upstreams asks it.
 *
 * Scoped to the image the manifest declares. Every other Dockerfile here starts FROM node or
 * debian pinned by digest, and a rule that looked at any digest-bearing FROM would fail seven
 * templates for being careful.
 */
export function checkUpstreamFrom(upstream, dockerfile) {
  const image = String(upstream?.image ?? '');
  if (!image) return null;
  const want = splitPin(upstream?.pinned);

  // EVERY matching stage, not the first. A multi-stage build takes its final stage by default, so
  // `FROM upstream:1.2.3 AS old` followed by `FROM upstream:9.9.9` would otherwise pass on the
  // strength of a stage the image never uses, while the one it does use has drifted.
  for (const line of instructions(dockerfile).split('\n')) {
    // `FROM [--platform=... --flag=...] <ref> [AS name]`. Skipping the flags matters: reading the
    // first token as the image made a standard `FROM --platform=linux/amd64 <ref>` invisible.
    const m = /^\s*FROM\s+((?:--\S+\s+)*)(\S+)/i.exec(line);
    if (!m) continue;
    const got = splitRef(m[2]);
    if (got.image !== image) continue;
    if (!got.tag) return { error: `Dockerfile builds on ${image} with no tag, so nothing pins which version it gets` };
    if (got.tag !== want.tag) {
      return { error: `Dockerfile builds on ${image}:${got.tag} but the manifest pins '${want.tag}': the two have drifted` };
    }
    // Only when the manifest carries one of its own. 9router and hermes pin a tag and let the
    // Dockerfile add the digest, which is a choice about where the digest lives, not a mismatch.
    if (want.digest && got.digest !== want.digest) {
      return { error: `Dockerfile pins ${image}:${got.tag} at a different digest than the manifest does` };
    }
  }
  return null;
}

/**
 * Does this Dockerfile name the version its manifest claims?
 *
 * @param {{pinned?: unknown, commit?: unknown}} upstream  the manifest's `upstream` block
 * @param {string} dockerfile                              the Dockerfile's text
 * @returns {{error: string} | null}                       null when they agree
 */
export function checkDockerfilePin(upstream, dockerfile) {
  const text = instructions(dockerfile);
  // An absent pin must not count as a match: `"anything".includes("")` is true, which would let
  // every Dockerfile pass and make this decoration rather than a check.
  const pins = [upstream?.pinned, upstream?.commit]
    .map((v) => (v === undefined || v === null ? '' : String(v).trim()))
    .filter(Boolean);

  if (!pins.length) {
    return { error: 'has a Dockerfile but declares no upstream.pinned or upstream.commit for it to be checked against' };
  }
  if (pins.some((pin) => names(text, pin))) return null;
  return {
    error: `Dockerfile names none of ${pins.map((p) => `'${p}'`).join(' or ')}: the manifest and the Dockerfile have drifted, `
      + 'so the image would be built from a different version than the catalog advertises',
  };
}
