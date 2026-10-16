// Pure helpers for publish.mjs, kept separate so they can be tested without running the publisher
// (which talks to the catalog and calls process.exit).

/**
 * Split a `ghcr.io/<owner>/<name...>:<tag>` or `@<digest>` reference.
 * `name` may be multi-segment, and ghcr's API path keeps those slashes:
 * /v2/<owner>/<name>/manifests/<reference>.
 * Returns null for anything that is not a ghcr reference.
 */
export function parseGhcrRef(ref) {
  const s = String(ref ?? "");
  if (!s.startsWith("ghcr.io/")) return null;
  const path = s.slice("ghcr.io/".length);
  if (!path) return null;
  const at = path.indexOf("@");
  if (at >= 0) return { repo: path.slice(0, at), tag: path.slice(at + 1) };
  const colon = path.lastIndexOf(":");
  // A colon only introduces a tag when it comes after the last slash; otherwise it is part of a
  // host:port style prefix we do not expect here.
  if (colon > path.lastIndexOf("/")) return { repo: path.slice(0, colon), tag: path.slice(colon + 1) };
  return { repo: path, tag: "latest" };
}

/**
 * Whether an anonymous 401/403 from ghcr is worth waiting out.
 *
 * ghcr answers 403 to an ANONYMOUS caller both for a package that does not exist
 * yet and for one that exists but is private, so the status alone cannot tell
 * "the image build has not pushed it" from "someone has to flip visibility".
 * The authenticated probe separates them: only a probe that RESOLVES (status 0)
 * proves the image exists and is hidden, which will not self-heal, so fail.
 *
 * Getting this wrong is why every merge that bumped an image version failed and
 * needed a manual re-run: templates-build-images runs on the same push and takes
 * minutes, so publish always saw the anonymous 403 of a package still being
 * built, called it private, and gave up without using its retry budget.
 *
 * Everything else is inconclusive and gets `retry`: no GHCR_TOKEN to ask with,
 * 404 (not there yet), 401/403 (the token itself is expired or lacks access),
 * 429/5xx (ghcr is having a moment). None of those prove the image is private,
 * the budget is bounded, and failing a build that would have succeeded costs
 * more than spending it.
 *
 * @param {{anon: number, auth: number|null|undefined}} o
 * @returns {"retry"|"fatal"}
 */
export function ghcrRetryVerdict({ anon, auth }) {
  if (anon !== 401 && anon !== 403) return "retry";
  return auth === 0 ? "fatal" : "retry";
}

/**
 * The failure message for an image that is not anonymously pullable.
 *
 * Anonymous is what matters: a template deploy pulls with no credentials. The authenticated probe
 * exists only to tell the two causes apart, because the fix differs.
 *
 * @param {object} o
 * @param {string} o.name  the service name
 * @param {string} o.ref   the image reference
 * @param {number} o.anon  HTTP status from the anonymous probe (never 0 here)
 * @param {number|null} o.auth  HTTP status from the authenticated probe, 0 when it succeeded,
 *                              or null when no GHCR_TOKEN was available to classify with
 */
export function ghcrGateMessage({ name, ref, anon, auth }) {
  if (auth === 0) {
    return `services.${name}: ${ref} exists but is NOT anonymously pullable (anonymous HTTP ${anon}, authenticated OK). ` +
      `Template deploys pull anonymously, so publishing this would register an image nobody can pull. ` +
      `Fix: set the ghcr package public (GitHub org → Packages → the package → Package settings → Change visibility), ` +
      `then re-run templates-publish via workflow_dispatch.`;
  }
  const authNote = auth === null
    ? "no GHCR_TOKEN was set, so this could not be told apart from a private package"
    : `authenticated HTTP ${auth}`;
  return `services.${name}: ${ref} did not resolve on ghcr (anonymous HTTP ${anon}, ${authNote}). ` +
    `Either the image is not published yet, so wait for templates-build-images and re-run ` +
    `templates-publish via workflow_dispatch (it upserts), or the package is private and needs ` +
    `its visibility changed.`;
}

/**
 * A README is authored for GitHub, where `![](./shot.png)` resolves against the repo. The catalog
 * serves the same text on another origin, where that path would resolve against THAT site and 404.
 * So every relative target becomes absolute, pinned to the publishing commit: images through the
 * same CDN as the logo, links to the GitHub page a reader can actually browse.
 *
 * @param {string} text            the README source
 * @param {object} opts
 * @param {string} opts.dirInRepo  the template directory, repo-relative (e.g. "templates/hermes")
 * @param {string} opts.repo       "<owner>/<repo>"
 * @param {string} opts.sha        the commit to pin to
 * @param {(p: string) => boolean} [opts.isDirectory]  does this repo-relative path name a directory
 * @throws when an image escapes its template directory, or any target escapes the repository
 */
export function rewriteReadme(text, { dirInRepo, repo, sha, isDirectory = () => false }) {
  const cdn = (p) => `https://cdn.jsdelivr.net/gh/${repo}@${sha}/${p}`;
  // `blob` renders a file; a directory needs `tree`, or GitHub serves a broken URL.
  const page = (p, endsWithSlash) =>
    `https://github.com/${repo}/${endsWithSlash || isDirectory(p) ? "tree" : "blob"}/${sha}/${p}`;

  const resolve = (target, isImage) => {
    // Absolute, protocol-relative, root-relative, anchor-only and mail targets are left alone.
    if (/^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(target)) return null;
    const [, path, suffix = ""] = /^([^?#]*)([?#].*)?$/.exec(target);
    if (!path) return null;
    const stack = dirInRepo ? dirInRepo.split("/") : [];
    for (const part of path.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (!stack.length) throw new Error(`README target '${target}' escapes the repository`);
        stack.pop();
      } else stack.push(part);
    }
    const resolved = stack.join("/");
    // An image must live in its own template directory: nothing outside it is the template's to ship.
    if (isImage && !resolved.startsWith(`${dirInRepo}/`)) {
      throw new Error(`README image '${target}' points outside the template directory; keep assets in ${dirInRepo}/`);
    }
    if (isImage) return cdn(resolved) + suffix;
    return page(resolved, path.endsWith("/")) + suffix;
  };

  let out = text;
  // Markdown images first, then markdown links (the leading [^!] keeps images out of the link pass).
  out = out.replace(/(!\[[^\]]*\]\()([^)\s]+)/g, (m, head, target) => head + (resolve(target, true) ?? target));
  out = out.replace(/(^|[^!])(\[[^\]]*\]\()([^)\s]+)/g, (m, pre, head, target) => pre + head + (resolve(target, false) ?? target));
  // Inline HTML images.
  out = out.replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi,
    (m, head, q, target) => head + q + (resolve(target, true) ?? target) + q);
  return out;
}

/**
 * The repo-relative path of the one-click button asset. Referenced from a README as an absolute
 * CDN URL (rewriteReadme leaves absolute targets alone), so this is matched as a URL SUFFIX.
 */
export const DEPLOY_BUTTON_ASSET = "assets/deploy-button.svg";

// A whole line that is nothing but the linked button image. Anchored, and without /g, so it can
// be tested line by line without carrying lastIndex between calls.
//
// Three bounds keep it from taking something that merely looks like the button:
//   ^[ ]{0,3}  a paragraph may be indented up to three spaces. FOUR spaces, or a tab, opens an
//              indented code block, where the same line is a sample rather than an affordance,
//              and the fence tracking below only covers the fenced spelling of a sample.
//   (?:...(/)? the asset has to be the LAST path segment, so 'myassets/deploy-button.svg' and a
//              path that merely ends in the same letters are not it.
//   (?:[?#]..) and it has to end there, give or take a query or a fragment, so a neighbouring
//              file like 'deploy-button.svg.bak' stays.
const DEPLOY_BUTTON_LINE = new RegExp(
  `^[ ]{0,3}\\[!\\[[^\\]]*\\]\\((?:[^)\\s]*/)?${DEPLOY_BUTTON_ASSET.replace(/[.]/g, "\\.")}(?:[?#][^)\\s]*)?\\)\\]\\(([^)\\s]*)\\)[ \\t]*$`,
);

// A code fence: up to three spaces, three or more backticks or tildes, then the rest of the line
// (an info string, on an opening fence).
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The one place that decides what IS the button, so the publisher and the lint cannot drift:
 * stripDeployBadge removes exactly what this finds, and lint.mjs validates exactly what this
 * finds. A looser test in either one is a way for a README to pass CI carrying something the
 * other will not act on.
 *
 * @param {string} text
 * @returns {{ lines: string[], hits: Map<number, string> }} lines, and line index -> href
 */
function scanDeployButtons(text) {
  const lines = String(text ?? "").split("\n");
  const hits = new Map();
  // Tracked as the OPENING fence's character and length, not as a parity flip: CommonMark closes
  // a fence only with the same character, at least as long, carrying nothing else, so a
  // four-backtick block quoting a three-backtick line stays open.
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE.exec(lines[i]);
    if (f) {
      const [, bars, rest] = f;
      const char = bars[0];
      if (!fence) {
        // A backtick fence's info string may not itself contain a backtick, which is what keeps
        // an inline code span from opening a block.
        if (char !== "`" || !rest.includes("`")) fence = { char, len: bars.length };
      } else if (char === fence.char && bars.length >= fence.len && rest.trim() === "") {
        fence = null;
      }
      continue; // a fence line is never the button
    }
    // Inside a fence the same line is DOCUMENTATION of the button rather than the button itself,
    // and the snippet in assets/README.md is exactly that.
    if (fence) continue;
    const m = DEPLOY_BUTTON_LINE.exec(lines[i]);
    if (m) hits.set(i, m[1]);
  }
  return { lines, hits };
}

// The asset named as a whole path, bounded on BOTH sides by something that cannot be part of one.
// Deliberately looser than DEPLOY_BUTTON_LINE about the markdown around it (see the draft check in
// lint.mjs) but exact about WHICH FILE, because a different file renders as that file:
// `myassets/…`, `foo.assets/…`, `…deploy-button.svg.bak` and `…deploy-button.svgx` are all
// other files, and DEPLOY_BUTTON_LINE already leaves every one of them alone. A test that says so
// is what stops these two from contradicting each other again.
//
// The asset has to be a whole path, so the bound is what SURROUNDS it, and it is spelled as an
// ALLOW-LIST of characters that cannot be part of a path. The obvious way round, listing the
// characters that can, was wrong twice in a row for the same reason: a deny-list of path
// characters is never finished. It missed non-ASCII letters, then combining marks, and after
// those would come format characters, joiners, and whatever else Unicode adds. Inverting it ends
// the category: anything not named here counts as part of a name, so
// `eassets/…`, `\u00e9assets/…` and `e\u0301assets/…` are all somebody else's file without the
// class having to know what a combining acute is.
//
// What terminates the path is MARKDOWN and HTML syntax, not URL syntax. Several characters RFC
// 3986 allows in a path are punctuation too, `! $ & ' ( ) * + , ; = : @`, and treating those as
// boundaries reported a different file as this one: `deploy-button.svg!x` is a legal filename,
// and not ours. So this names only what actually ends a URL where a README puts one.
//
// Two of them are kept anyway, because the demands genuinely conflict. `)` is legal in a path,
// but CommonMark requires parentheses inside a link destination to be balanced or escaped, so an
// unbalanced one IS the end of the destination; a filename that really contains one arrives
// percent-encoded or wrapped in <>. A quote is legal in a path too, and is also how an HTML
// attribute closes. Both are resolved the same way, by which mistake costs more: this list feeds
// the DRAFT check, where failing to see a button ships a live link to a route that does not exist
// yet, and seeing one too many costs an author one message about a filename nobody has. So where
// the two readings collide, it errs toward seeing.
//
// The sides are also split by direction, not just by the slash: an OPENING delimiter can only
// precede the path and a CLOSING one can only follow it, so neither list carries the other's.
//
// Left: nothing (start of input), a slash, which ENDS the previous segment, or what opens a
// destination or an attribute value. Covers `](<cdn>/assets/...)`, `](assets/...)`,
// `src="assets/..."` and a bare path at the start of a line.
const LEFT_BOUND = "\\s/(\\[{<\"'`|=";
// Right: what closes one, plus the `?` and `#` that open a query or a fragment, and NOT a
// slash: `assets/deploy-button.svg/extra` names something BELOW the file, not the file.
const RIGHT_BOUND = "\\s)\\]}>\"'`|?#";
const ASSET_MENTION = new RegExp(
  `(?:^|[${LEFT_BOUND}])${DEPLOY_BUTTON_ASSET.replace(/[.]/g, "\\.")}(?:$|[${RIGHT_BOUND}])`,
  "u",
);

/**
 * Does this README name the button asset at all, in any form: linked or not, fenced or not,
 * inline in prose or alone on its line.
 *
 * This is the question "is the asset mentioned", NOT "is there a button" (findDeployButtons).
 * lint.mjs wants the first for its draft rule, where the risk is what a reader can click rather
 * than what publish strips, and the second everywhere else.
 *
 * @param {string} text  the README source
 * @returns {boolean}
 */
export function mentionsDeployButtonAsset(text) {
  return ASSET_MENTION.test(String(text ?? ""));
}

/**
 * Every deploy button in a README, as the href each one links to. Empty when the asset is only
 * mentioned: unlinked, indented into a code block, inside a fence, or a neighbouring filename.
 * Used by lint.mjs so it checks the same affordance publish removes.
 *
 * @param {string} text  the README source
 * @returns {string[]}   one href per button, in document order
 */
export function findDeployButtons(text) {
  return [...scanDeployButtons(text).hits.values()];
}

/**
 * Drop the "Deploy on InstaCloud" button from a README on its way to the catalog.
 *
 * The button is authored for GitHub, where a template directory has no deploy affordance of its
 * own. The gallery serves this same text on the page the button now POINTS AT, whose rail already
 * carries a Deploy Now, so republished verbatim it is both a second call to action in the middle
 * of the prose and a link to the page you are reading. The gallery's markdown renderer also parses
 * no raw HTML, so there is no <picture> or conditional-comment escape hatch to hide it with.
 * Stripping at publish keeps one README serving both surfaces.
 *
 * @param {string} text  the README source
 * @returns {string}     the same text with any button line, and the blank line it left behind, gone
 */
export function stripDeployBadge(text) {
  const { lines, hits } = scanDeployButtons(text);
  if (!hits.size) return text; // nothing to remove, and no rejoin that could alter the text
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!hits.has(i)) {
      out.push(lines[i]);
      continue;
    }
    // The button sits in its own paragraph, so removing the line alone would leave the blank line
    // above AND below it: take the trailing one, and only when a blank line is already standing.
    const nextIsBlank = lines[i + 1] !== undefined && lines[i + 1].trim() === "";
    const prevIsBlank = out.length > 0 && out[out.length - 1].trim() === "";
    if (nextIsBlank && prevIsBlank) i++;
  }
  return out.join("\n");
}
