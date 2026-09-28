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
  // `build` also joins continuations, which is what docker actually executes and therefore what
  // decides whether the pin is genuinely in the build at all.
  const noComments = df === null ? '' : df.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const build = noComments.replace(/\\[ \t]*\r?\n[ \t]*/g, ' ');

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

  // The deployed image. Ours carries the TEMPLATE version, theirs carries the upstream's, and the
  // two are different numbers: getting this backwards publishes a ghcr tag nobody expects.
  const ours = new RegExp(`^(\\s*image:\\s*ghcr\\.io/insforge/insta-oss/templates/[^:\\s]+):${esc(version)}`, 'm').exec(text);
  if (ours) {
    edits.push(edit('manifest', ours[0], `${ours[1]}:${next}`, 'our published tag is the template version'));
  } else {
    const theirs = new RegExp(`^(\\s*image:\\s*\\S+):${esc(drift.from)}\\s*$`, 'm').exec(text);
    if (theirs) edits.push(edit('manifest', theirs[0], `${theirs[1]}:${drift.to}`, 'this template deploys the upstream image directly'));
  }

  if (df !== null) {
    // A Dockerfile that does not name the old pin is a refusal, not a file to skip. Bumping the
    // manifest alone leaves the image built from the old upstream while the catalog advertises the
    // new one, which is the exact outcome the rest of this exists to prevent, and it was reported
    // as applied. The manifest and the Dockerfile move together or neither moves.
    //
    // Comments do not count. `# bumped from 2.1.235` over an install line that has already moved
    // on is the most natural sentence to write while bumping by hand, and it made this rewrite the
    // COMMENT, bump the manifest, and report a synchronized move that had not happened. When the
    // pin is in both a comment and an instruction, applyEdits refuses it as ambiguous instead.
    if (!build.includes(drift.from)) {
      return { error: `the Dockerfile does not name '${drift.from}' in any instruction, so the manifest cannot be moved without leaving the image built from the old version` };
    }
    // A FROM that pins tag AND digest has to move both. Docker prefers the digest, so moving the
    // tag alone builds the OLD image under the new number and every check downstream agrees with
    // the lie. Without a digest to move to there is no safe edit here.
    const from = new RegExp(`^(\\s*FROM\\s+(?:--\\S+\\s+)*\\S+?):${esc(drift.from)}@(\\S+)`, 'mi').exec(noComments);
    if (from) {
      if (!drift.digest) return { error: `${from[1].trim()} pins a digest beside its tag and the drift carries none, so moving the tag alone would ship the old image` };
      edits.push(edit('dockerfile', from[0], `${from[1]}:${drift.to}@${drift.digest}`, 'the tag and the digest are one pin'));
    } else {
      edits.push(edit('dockerfile', drift.from, drift.to, 'the Dockerfile installs the pinned version'));
    }
  }

  return { version: { from: version, to: next }, edits };
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
