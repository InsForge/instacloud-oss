// Has a template's upstream moved since we pinned it.
//
// Read-only and deterministic: one HTTP call per template, no files touched, no pull request
// opened. What it returns is a list of moves for something else to act on, and the three rules it
// may not break are here rather than in whatever calls it.
//
//   Forward only.   `to` must be strictly greater than `from` where the two can be ordered. A
//                   yanked release or a registry hiccup must never produce an automatic downgrade.
//   Unsure is still. A resolution it cannot make confidently answers `unknown` with the reason and
//                   proposes nothing. Guessing a version and opening a pull request from the guess
//                   is worse than being behind.
//   Read only.      No file is edited and nothing is opened. The list is the whole product.
//
// The noise these rules exist for is not hypothetical. Measured 2026-09-27: `@openai/codex` had
// published 365 versions in seven days, nearly all per-platform alphas, and docker.io/n8nio/n8n's
// 25 most recently updated tags were all nightlies. Taking "the newest thing" from either would
// propose `0.159.0-alpha.9-win32-arm64` or `v3-nightly-20260927`.

const SHA = /^[0-9a-f]{40}$/i;
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
/** A docker tag we will consider: a plain version and nothing else. No nightly, no -arm64, no rc. */
const PLAIN_TAG = /^v?\d+\.\d+\.\d+$/;
/** A digest as a registry writes one. Anything else from a remote is not a digest we will paste. */
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * How this template is pinned, which decides where to look.
 *
 * `repo` is NOT the discriminator: nine of the ten manifests carry it, because it says where the
 * project lives rather than how it is pinned. Neither is `image` a statement that we deploy it:
 * 9router, hermes and openclaw all declare an upstream image and build their own on top, and only
 * n8n deploys the upstream's image directly.
 */
export function kindOf(upstream) {
  const pinned = String(upstream?.pinned ?? '');
  if (upstream?.package) return { kind: 'npm' };
  if (upstream?.image) return { kind: pinned.includes('@sha256:') ? 'docker-digest' : 'docker-tag' };
  if (upstream?.repo && (upstream?.commit || SHA.test(pinned))) return { kind: 'git-commit' };
  return {
    unknown: 'cannot tell how this is pinned: no upstream.package, no upstream.image, and no repo with a commit',
  };
}

/** What the manifest currently claims, which differs by kind: laya pins a commit AND a release. */
const pinOf = (upstream, kind) =>
  String((kind === 'git-commit' ? (upstream?.commit ?? upstream?.pinned) : upstream?.pinned) ?? '');

const parse = (v) => {
  const m = SEMVER.exec(String(v ?? '').trim());
  return m ? { nums: [+m[1], +m[2], +m[3]], pre: m[4] } : null;
};

/** Compare one prerelease tail against another, numerically where the identifiers are numbers. */
function comparePre(a, b) {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1; // a release outranks any prerelease of the same numbers
  if (b === undefined) return -1;
  const A = a.split('.');
  const B = b.split('.');
  for (let i = 0; i < Math.max(A.length, B.length); i += 1) {
    if (A[i] === undefined) return -1;
    if (B[i] === undefined) return 1;
    const both = /^\d+$/.test(A[i]) && /^\d+$/.test(B[i]);
    const d = both ? +A[i] - +B[i] : A[i].localeCompare(B[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Negative when `a` is older, 0 when equal, positive when newer, and **null when they cannot be
 * ordered at all**, which is the answer for a commit sha or a digest.
 *
 * Null is not a failure. A force-push moves a branch backwards and looks exactly like moving it
 * forwards, so calling that an upgrade would be a claim nobody can support.
 */
export function compareVersions(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  return comparePre(x.pre, y.pre);
}

/** major, minor or patch, for a move that could be ordered. */
function bumpLevel(from, to) {
  const x = parse(from);
  const y = parse(to);
  if (!x || !y) return null;
  if (x.nums[0] !== y.nums[0]) return 'major';
  if (x.nums[1] !== y.nums[1]) return 'minor';
  return 'patch';
}

/** How long any one registry read may take. A stalled host must not hang a scheduled run. */
const REQUEST_TIMEOUT_MS = 20000;
const timeout = () => (typeof AbortSignal?.timeout === 'function' ? { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) } : {});

/**
 * Every tag an image has, from the registry rather than from Docker Hub's website API.
 *
 * Two calls: an anonymous pull token, then the list. The token is free and unauthenticated in the
 * sense that matters, it just has to be asked for, and in exchange the answer is complete instead
 * of a page at a time behind a rate limit.
 */
async function registryTags(ns, name, fetchImpl) {
  try {
    const auth = await json(fetchImpl, `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${ns}/${name}:pull`);
    if (!auth?.token) return { unknown: `the registry issued no pull token for ${ns}/${name}` };
    const res = await fetchImpl(`https://registry-1.docker.io/v2/${ns}/${name}/tags/list`, {
      headers: { accept: 'application/json', authorization: `Bearer ${auth.token}` },
      ...timeout(),
    });
    if (!res?.ok) return { unknown: `the registry answered ${res?.status ?? 'nothing'} for ${ns}/${name}` };
    const body = await res.json();
    return Array.isArray(body?.tags) ? { names: body.tags.filter((t) => typeof t === 'string') } : { unknown: `${ns}/${name} listed no tags` };
  } catch (e) {
    return { unknown: `could not list tags for ${ns}/${name}: ${e.message}` };
  }
}

const json = async (fetchImpl, url) => {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, ...timeout() });
  if (!res?.ok) throw new Error(`${url} answered ${res?.status ?? 'nothing'}`);
  return res.json();
};

/**
 * What the pin SHOULD be right now, by kind.
 *
 * npm reads a dist-tag rather than the highest version because the dist-tag is the maintainer's own
 * answer to "what should people install", and it is the only thing that makes codex tractable.
 * `stable` wins over `latest` where both exist: claude-code publishes both and they differ.
 */
export async function resolveUpstream(upstream, deps = {}) {
  const { fetchImpl = fetch } = deps;
  const k = kindOf(upstream);
  if (k.unknown) return k;
  const unknown = (why) => ({ kind: k.kind, unknown: why });

  try {
    if (k.kind === 'npm') {
      const body = await json(fetchImpl, `https://registry.npmjs.org/${String(upstream.package).replace('/', '%2F')}`);
      const tags = body?.['dist-tags'] ?? {};
      const current = tags.stable ?? tags.latest;
      if (!current) return unknown('the registry published no stable or latest dist-tag');
      // A dist-tag is whatever the maintainer wrote there. One that is not a version cannot be
      // ordered against the pin, and an unorderable npm value would otherwise flow through as a
      // "changed, not comparable" move and get pasted into a manifest.
      if (!SEMVER.test(String(current))) return unknown(`the ${tags.stable ? 'stable' : 'latest'} dist-tag is '${current}', which is not a version this can order`);
      return { kind: k.kind, current: String(current) };
    }

    if (k.kind === 'docker-tag') {
      const ref = String(upstream.image);
      // Docker Hub is the only registry this can read without credentials. ghcr needs a token
      // dance, so a ghcr-hosted upstream answers unknown rather than being guessed at.
      const m = /^docker\.io\/([^/]+)\/([^/:]+)$/.exec(ref);
      if (!m) return unknown(`${ref} is not on docker.io, and only Docker Hub can be read anonymously`);
      // The registry's OWN tag list, not Docker Hub's browse endpoint. Hub paginates by recent
      // activity and refuses an anonymous caller at page 11 with a 403, and n8n has 5531 tags of
      // which only three in the first hundred are plain versions, so a partial list there reads as
      // a confident "up to date" the moment a burst of nightlies lands. The registry answers with
      // all 5531 in one call, for a token anyone can mint.
      const listed = await registryTags(m[1], m[2], fetchImpl);
      if (listed.unknown) return unknown(listed.unknown);
      const plain = listed.names.filter((n) => PLAIN_TAG.test(n));
      if (!plain.length) return unknown('no tag on that image is a plain version');
      const current = plain.reduce((a, b) => ((compareVersions(a, b) ?? 0) < 0 ? b : a));
      // And the digest of the tag just chosen, because three templates write BOTH into their FROM
      // and moving the tag without it is the worst kind of wrong: docker prefers the digest, so the
      // build succeeds and ships the old image while everything claims the new version.
      const picked = await tagDigest(ref, current, deps);
      return { kind: k.kind, current, digest: picked.digest ?? null };
    }

    if (k.kind === 'git-commit') {
      const repo = String(upstream.repo);
      const tags = await json(fetchImpl, `https://api.github.com/repos/${repo}/tags`);
      const tagged = Array.isArray(tags) ? tags[0]?.commit?.sha : null;
      if (tagged) return { kind: k.kind, current: String(tagged) };
      // No tags at all, which is whisper-turbo: the project releases by pushing. Following the
      // default branch is the only pin there is, and it is the one we already took when we pinned
      // a bare sha in the first place.
      const meta = await json(fetchImpl, `https://api.github.com/repos/${repo}`);
      const branch = meta?.default_branch;
      if (!branch) return unknown('that repository has no tags and names no default branch');
      const head = await json(fetchImpl, `https://api.github.com/repos/${repo}/commits/${branch}`);
      const sha = head?.sha;
      return sha ? { kind: k.kind, current: String(sha) } : unknown(`could not read the head of ${branch}`);
    }

    // docker-digest: resolving what a floating tag points at needs a registry token this cannot
    // get anonymously on every host, so it is reported rather than guessed.
    return unknown('a tag pinned by digest needs a registry token to re-resolve');
  } catch (e) {
    return unknown(`could not read the upstream: ${e.message}`);
  }
}

/**
 * The move, if there is one: `null` when the pin is already current.
 *
 * `comparable: false` means the two differ but cannot be ordered, which is every commit sha. That
 * is reported as a change and never as an upgrade, and the distinction is what a person needs in
 * order to decide.
 */
export async function upstreamDrift(upstream, deps = {}) {
  const resolved = await resolveUpstream(upstream, deps);
  if (resolved.unknown) return resolved;
  const kind = resolved.kind;
  const from = pinOf(upstream, kind);
  const to = resolved.current;
  if (!from) return { kind, unknown: 'the manifest declares no pin to compare against' };
  if (from === to) return null;

  // Carried through so whatever applies the edit has both halves of a pin that has two.
  const digest = resolved.digest ? { digest: resolved.digest } : {};
  const cmp = compareVersions(from, to);
  if (cmp === null) return { kind, from, to, comparable: false, level: null, ...digest };
  if (cmp >= 0) return null; // equal, or the registry went backwards: never a downgrade
  return { kind, from, to, comparable: true, level: bumpLevel(from, to), ...digest };
}

/**
 * What a specific tag points at right now.
 *
 * Separate from resolving the newest version because it answers a different question: not "is there
 * something newer" but "is the thing we pinned still the thing we pinned". An upstream that
 * re-pushes a tag changes what we build from without changing a line in this repository, and the
 * digest beside the tag in a FROM is the only record that would disagree.
 */
export async function tagDigest(image, tag, deps = {}) {
  const { fetchImpl = fetch } = deps;
  const m = /^docker\.io\/([^/]+)\/([^/:]+)$/.exec(String(image));
  if (!m) return { unknown: `${image} is not on docker.io, and only Docker Hub can be read anonymously` };
  try {
    const body = await json(fetchImpl, `https://hub.docker.com/v2/repositories/${m[1]}/${m[2]}/tags/${tag}`);
    const d = body?.digest ? String(body.digest) : '';
    // Whatever a remote says goes into a Dockerfile, so it has to look like a digest first.
    return DIGEST.test(d) ? { digest: d } : { unknown: `${image}:${tag} reports no usable digest` };
  } catch (e) {
    return { unknown: `could not read ${image}:${tag}: ${e.message}` };
  }
}
