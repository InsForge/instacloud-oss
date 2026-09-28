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
 * Does this Dockerfile name the version its manifest claims?
 *
 * @param {{pinned?: unknown, commit?: unknown}} upstream  the manifest's `upstream` block
 * @param {string} dockerfile                              the Dockerfile's text
 * @returns {{error: string} | null}                       null when they agree
 */
export function checkDockerfilePin(upstream, dockerfile) {
  const text = String(dockerfile ?? '');
  // An absent pin must not count as a match: `"anything".includes("")` is true, which would let
  // every Dockerfile pass and make this decoration rather than a check.
  const pins = [upstream?.pinned, upstream?.commit]
    .map((v) => (v === undefined || v === null ? '' : String(v).trim()))
    .filter(Boolean);

  if (!pins.length) {
    return { error: 'has a Dockerfile but declares no upstream.pinned or upstream.commit for it to be checked against' };
  }
  if (pins.some((pin) => text.includes(pin))) return null;
  return {
    error: `Dockerfile names none of ${pins.map((p) => `'${p}'`).join(' or ')}: the manifest and the Dockerfile have drifted, `
      + 'so the image would be built from a different version than the catalog advertises',
  };
}
