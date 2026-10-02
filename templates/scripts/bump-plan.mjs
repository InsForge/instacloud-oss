// Turning a drift into a diff.
//
// A version lives in three or four places per template and the set differs by how it is pinned, so
// most of this is knowing which places. The rest is a rule about how to edit them: by TARGETED
// REPLACEMENT, each of which must match exactly once, and never by loading the YAML and dumping it
// back. These manifests are full of load-bearing comments, laya's explains why it pins a commit
// rather than the PyPI release, and a round trip through js-yaml deletes every one of them.
//
// Nothing here writes a file. It returns a plan, the plan is readable before it is applied, and
// applyEdits refuses any of it that no longer matches.

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Our own template version, moved by the level the upstream moved. */
function bumpVersion(version, level) {
  const m = SEMVER.exec(String(version ?? '').trim());
  if (!m) return null;
  const [major, minor, patch] = [+m[1], +m[2], +m[3]];
  // A commit sha has no level. Ours moves by a patch, because it DID move and version-guard
  // requires a change, and claiming a minor for something we cannot size would be an invention.
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const esc = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const edit = (file, find, replace, why) => ({ file, find, replace, why });

/** Where templates-build-images.yml pushes the images we build ourselves. */
const OURS = 'ghcr.io/insforge/insta-oss/templates/';

/** `image`, `image:tag` or `image:tag@sha256:...`. The tag's colon is the one after the last slash. */
function splitTag(ref) {
  const [head, digest] = String(ref).split('@');
  const slash = head.lastIndexOf('/');
  const colon = head.lastIndexOf(':');
  const tagged = colon > slash;
  return { repo: tagged ? head.slice(0, colon) : head, tag: tagged ? head.slice(colon + 1) : '', digest: digest ?? '' };
}

// `n8nio/n8n` and `docker.io/n8nio/n8n` are one image, and Docker Hub is the only registry a
// reference may leave out, so dropping that host from both sides is the whole comparison. Anything
// this does not recognize falls through as a sidecar and, if it was the only image, the plan is
// refused for having nothing to move rather than passing with the service left behind.
const bare = (image) => String(image).replace(/^(?:index\.|registry-1\.)?docker\.io\//, '');
const sameImage = (a, b) => bare(a) === bare(b);

/**
 * Every file change one upstream move implies, or a refusal.
 *
 * Refuses rather than edits around a surprise. The detector read these files at some earlier
 * moment, and if what it saw is no longer there the honest answer is to do nothing and be re-run.
 */
export function planBump({ manifest, dockerfile, drift }) {
  if (!drift || drift.unknown || !drift.to) return { error: 'no resolved upstream move to apply' };
  const text = String(manifest ?? '');
  const df = dockerfile === undefined ? null : String(dockerfile);
  // Two readings of the same Dockerfile. `noComments` drops comment lines and leaves every other
  // line byte for byte, so a match in it is a string applyEdits can still find in the real file.
  // `build` goes on to join continuations and then drop the comments a shell drops, which is what
  // docker actually executes and therefore what decides whether the pin is in the build at all.
  // An INLINE comment is the same trap as a comment line and survived the first fix: with
  // `RUN npm install -g x@9.9.9 # previously pinned at 2.1.235` this rewrote the comment, bumped the
  // manifest, and reported a synchronized move that had not happened.
  const noComments = df === null ? '' : df.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const build = noComments
    .replace(/\\[ \t]*\r?\n[ \t]*/g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s#.*$/, ''))
    .join('\n');

  const version = (/^version:\s*(\S+)/m.exec(text) ?? [])[1];
  const next = bumpVersion(version, drift.level);
  if (!next) return { error: `the manifest's version '${version}' is not a plain X.Y.Z, so there is no bump to make` };

  const edits = [edit('manifest', `version: ${version}`, `version: ${next}`, 'version-guard requires a changed template to change its version')];

  // The pin itself, in whichever field actually holds it. laya keeps its commit in `commit` and a
  // PyPI release in `pinned`, so only `commit` moves and the release is left alone; whisper-turbo
  // has no `commit` at all and keeps its sha in `pinned`. Hard-coding `commit` for the git kind
  // refused whisper-turbo outright, which is the same `commit ?? pinned` the detector already uses
  // to decide what it is comparing against, written twice and once wrongly.
  const pinField = drift.kind === 'git-commit' && /^\s{2}commit:/m.test(text) ? 'commit' : 'pinned';
  // A trailing comment is allowed and kept: 9router's pin carries one explaining why it is not
  // `latest`, and requiring the line to end at the value refused that template outright.
  const quoted = new RegExp(`^  ${pinField}:\\s*("?)${esc(drift.from)}\\1(\\s*(?:#.*)?)$`, 'm').exec(text);
  if (!quoted) return { error: `the manifest does not pin '${drift.from}' under upstream.${pinField}, so the drift was read from a different file than this one` };
  edits.push(edit('manifest', quoted[0], `  ${pinField}: ${quoted[1]}${drift.to}${quoted[1]}${quoted[2]}`, `the upstream moved to ${drift.to}`));

  // The deployed images. Ours carries the TEMPLATE version, theirs carries the upstream's, and the
  // two are different numbers: getting that backwards publishes a ghcr tag nobody expects.
  //
  // Every service image line is accounted for, or the plan is refused. Adding an edit only where a
  // regex happened to match let an unrecognized line pass in silence, so
  // `image: docker.io/n8nio/n8n:2.36.5 # official image` kept the deployed image on the old version
  // while the manifest version and the pin both moved, and the run reported it as applied: the
  // catalog/runtime mismatch the rest of this exists to prevent, announced as a success.
  //
  // Two spaces of indent is `upstream.image`, which declares what we TRACK. Four or more is a
  // service, which declares what we DEPLOY. Anything else in there is a sidecar and is left alone.
  const code = (/^code:\s*(\S+)/m.exec(text) ?? [])[1] ?? '';
  const tracked = (/^ {2}image:[ \t]*(\S+)/m.exec(text) ?? [])[1] ?? '';
  let images = 0;
  for (const [line, lead, ref] of text.matchAll(/^( {4,}image:[ \t]*)(\S+)/gm)) {
    const { repo, tag, digest } = splitTag(ref);
    // `mine` is THIS template's own published image, the one tagged with its version. An OURS image
    // for a DIFFERENT code is a companion: a second service this template runs (a browser worker,
    // say), built and versioned by a sibling template. It moves when that sibling bumps, not when
    // this one does, so it is left alone here exactly like any other sidecar.
    const mine = repo === `${OURS}${code}`;
    if (!mine && !(tracked && sameImage(repo, tracked))) continue;
    const want = mine ? version : drift.from;
    if (tag !== want) {
      return { error: `a service deploys ${repo} at '${tag || 'no tag'}' where this bump expects '${want}', so the manifest is not the file this drift was read from` };
    }
    // A tag beside a digest is one pin, exactly as in a FROM: docker prefers the digest, so moving
    // the tag alone would redeploy the OLD image under the new number.
    if (digest && !(!mine && drift.digest)) {
      return { error: `a service pins ${repo} at a digest beside its tag and there is none to move it to, so changing the tag alone would deploy the old image` };
    }
    const to = mine ? next : `${drift.to}${digest ? `@${drift.digest}` : ''}`;
    const why = mine ? 'our published tag is the template version' : 'this template deploys the upstream image directly';
    edits.push(edit('manifest', line, `${lead}${repo}:${to}`, why));
    images += 1;
  }
  if (!images) {
    return { error: 'no service deploys our image or the upstream one, so this bump would move the catalog and leave every running service on the old version' };
  }

  if (df !== null) {
    // The pin has to be moved where it IS the pin. Accepting it anywhere in an instruction and then
    // replacing the bare string rewrote whatever else carried the same number: with
    // `ENV UNRELATED=2.1.235` beside `RUN npm install -g x@9.9.9` the env moved, the manifest and
    // our image tag moved, the install line did not, and the run reported it applied. The FROM
    // branch had the same hole, taking any base image whose tag coincided rather than the one we
    // track. So each kind anchors on what NAMES the upstream, and where no anchor is found the
    // answer is a refusal rather than a replacement made on a guess.
    const pkg = (/^ {2}package:[ \t]*"?([^"\s]+)"?/m.exec(text) ?? [])[1] ?? '';
    const found = dockerfilePin({ pkg, image: tracked, build, noComments, drift });
    if (found.error) return { error: found.error };
    edits.push(...found.edits);
  }

  return { version: { from: version, to: next }, edits };
}

/**
 * Every replacement that moves the upstream pin in a Dockerfile, or the reason there is none.
 *
 * Anchored per kind, because a version on its own identifies nothing: `2.1.235` in an ENV, in a
 * LABEL, in a checksum and in an install line all look alike to a substring search, and only one of
 * them is the pin. What names the upstream is the package installed beside its version, the build
 * arg an install line reads, or a FROM on the repository the manifest tracks.
 */
function dockerfilePin({ pkg, image, build, noComments, drift }) {
  // What the RUN instructions actually run, without the `RUN` keyword.
  const runs = build.split('\n').filter((l) => /^\s*RUN\s/i.test(l)).map((l) => l.replace(/^\s*RUN\s+/i, '')).join('\n');

  if (drift.kind === 'docker-tag' || drift.kind === 'docker-digest') {
    if (!image) return { error: 'the drift is an image move and the manifest declares no upstream.image, so there is no FROM this can be sure of' };
    // EVERY stage that builds on it, not the first. Docker takes the final stage by default, so
    // returning at the first match moved `FROM upstream:2.36.5 AS base` and left the stage the image
    // actually comes from on the old tag, with the manifest claiming otherwise.
    const found = [];
    for (const line of noComments.split('\n')) {
      const m = /^(\s*FROM\s+(?:--\S+\s+)*)(\S+)(.*)$/i.exec(line);
      if (!m) continue;
      const { repo, tag, digest } = splitTag(m[2]);
      if (!sameImage(repo, image) || tag !== drift.from) continue;
      // A tag beside a digest is one pin. Docker prefers the digest, so moving the tag alone builds
      // the OLD image under the new number and every check downstream agrees with the lie.
      if (digest && !drift.digest) {
        return { error: `${repo} pins a digest beside its tag in the Dockerfile and the drift carries none, so moving the tag alone would ship the old image` };
      }
      const to = `${repo}:${drift.to}${digest ? `@${drift.digest}` : ''}`;
      // The whole line is the target, so two stages written differently are two distinct edits and
      // two written identically are one ambiguous target, which applyEdits refuses.
      found.push(edit('dockerfile', line, `${m[1]}${to}${m[3]}`, 'the Dockerfile builds on the image the manifest tracks'));
    }
    if (found.length) return { edits: found };
    return { error: `no FROM builds on ${image} at '${drift.from}', so the manifest cannot move without leaving the image built from the old version` };
  }

  if (drift.kind === 'npm') {
    if (!pkg) return { error: 'the drift is an npm move and the manifest declares no upstream.package, so there is nothing to anchor a Dockerfile edit to' };
    const direct = `${pkg}@${drift.from}`;
    if (installsSuch(runs, (w) => w === direct)) {
      return { edits: [edit('dockerfile', direct, `${pkg}@${drift.to}`, 'the Dockerfile installs the pinned version')] };
    }
    // Or a build arg an install command reads, which is how dsh pins it.
    const reads = new RegExp(`^${esc(pkg)}@\\$\\{?([A-Za-z_]\\w*)\\}?$`);
    const held = argHolding(noComments, drift, (name) => installsSuch(runs, (w) => reads.exec(w)?.[1] === name));
    return held ?? { error: `no command installs ${direct}, and no build arg holding '${drift.from}' is installed from, so the manifest cannot move without leaving the image built from the old version` };
  }

  // A commit. Forty hex characters identify themselves, so the build arg carrying one is the pin and
  // nothing else in a Dockerfile plausibly repeats it.
  const held = argHolding(noComments, drift, () => true);
  return held ?? { error: `the Dockerfile does not hold '${drift.from}' in a build arg, so there is nothing here this can move confidently` };
}

/**
 * Does some command in these RUN instructions install an argument the predicate accepts?
 *
 * Being somewhere in a RUN is not being installed by one. `RUN echo "previously foo@1.0.0" && npm
 * install -g foo@9.9.9` moved the echoed NOTE and left the install alone, and reported the two as
 * moved together. So the text is cut into commands at the operators that separate them, each
 * command's quoted strings are dropped because a shell only prints those, and the pin has to be an
 * argument of one whose command word is a package manager.
 *
 * Nothing here is a shell parser, and it is not trying to be. Every shape it does not recognize,
 * exec-form RUN among them, falls through to a refusal rather than to a replacement.
 */
function installsSuch(runs, accepts) {
  for (const command of runs.split(/&&|\|\||[;|\n]/)) {
    const words = command.replace(/"[^"]*"|'[^']*'/g, ' ').trim().split(/\s+/).filter(Boolean);
    // `sudo`, `env` and leading VAR=value assignments come before the command, and are not it.
    let i = 0;
    while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i]) || words[i] === 'sudo' || words[i] === 'env')) i += 1;
    if (!/^(?:npm|npx|yarn|pnpm|bun)$/.test(words[i] ?? '')) continue;
    if (words.slice(i + 1).some(accepts)) return true;
  }
  return false;
}

/** `ARG NAME=<pin>`, when `uses` recognizes NAME as the one the upstream is actually built from. */
function argHolding(noComments, drift, uses) {
  for (const line of noComments.split('\n')) {
    const m = new RegExp(`^(\\s*ARG\\s+([A-Za-z_]\\w*)=)("?)${esc(drift.from)}\\3([ \\t]*)$`).exec(line);
    if (m && uses(m[2])) {
      return { edits: [edit('dockerfile', m[0], `${m[1]}${m[3]}${drift.to}${m[3]}${m[4]}`, 'the Dockerfile builds from a pin held in a build arg')] };
    }
  }
  return null;
}

/**
 * Plan and apply in one step, and refuse in one way.
 *
 * Both halves can decline, and they used to decline differently: planBump returned an error the
 * caller reported, applyEdits threw and escaped, so an ambiguous target ended the whole run mid
 * loop with the templates it had already written left on disk and no report printed at all. A
 * refusal is a result here, not an exception, so a caller cannot forget to handle one.
 */
export function applyBump({ manifest, dockerfile, drift }) {
  const plan = planBump({ manifest, dockerfile, drift });
  if (plan.error) return { refused: plan.error };
  try {
    return { files: applyEdits({ manifest, ...(dockerfile !== undefined ? { dockerfile } : {}) }, plan.edits), version: plan.version };
  } catch (e) {
    return { refused: e.message };
  }
}

/**
 * The plan, applied. Every `find` must appear exactly once in its file or nothing is written: an
 * ambiguous target is how a version number in a comment gets edited instead of the one that counts.
 */
export function applyEdits(files, edits) {
  const out = { ...files };
  for (const e of edits) {
    const before = out[e.file];
    if (before === undefined) throw new Error(`the plan edits ${e.file}, which was not given`);
    const hits = before.split(e.find).length - 1;
    if (hits === 0) throw new Error(`'${e.find}' is not in ${e.file}, so the plan no longer matches it`);
    if (hits > 1) throw new Error(`'${e.find}' appears ${hits} times in ${e.file}, and an ambiguous target is not safe to replace`);
    out[e.file] = before.split(e.find).join(e.replace);
  }
  return out;
}
