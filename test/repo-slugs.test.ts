// The repo rename (insta-oss -> instacloud-oss, insta-cli -> instacloud-cli, insta-skills ->
// instacloud-skills) had to be swept by hand, and the sweep missed a leg: publish.mjs kept a
// hardcoded old slug as its GITHUB_REPOSITORY fallback, and nothing failed. A review's negative
// control then showed that reverting 28 of the 29 rewritten URLs left every gate green: tsc,
// eslint, the template linter, the version guard and the doc tests all passed on a fully
// sabotaged tree. Only the Dockerfile LABEL was bound, by test/image.int.test.ts.
//
// This test binds the rest. Both halves are verified by negative control, because a guard nobody
// has watched fail is worth nothing, which is the whole lesson above.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')

/** Case-sensitive on the owner, so the lowercase ghcr package path never matches: a container
 *  package does not move when its source repo is renamed, so `ghcr.io/insforge/insta-oss/...` is
 *  still the correct reference. */
const OLD_SLUG = /InsForge\/insta-(oss|cli|skills)\b/

/** The product name in user-facing prose. The lookarounds preserve the identifiers that
 *  deliberately keep the old name: `~/.insta-oss` and `insta-oss basebackup` are installed state,
 *  `InsForge/instacloud-oss` and `ghcr.io/insforge/insta-oss/...` are URLs, `insta-oss-ui` was
 *  renamed as a package rather than prose. */
const OLD_PRODUCT = /(?<![./\w-])insta-oss(?![-\w/])/

/** What git tracks, i.e. what we ship. Deliberately NOT a directory walk: the first version of
 *  this test skipped every root-level dot directory, which silently excluded the tracked
 *  `.github` tree, exactly where a stale workflow URL would live, and `.yml` was already the
 *  blind spot that let the template manifests through. The index also excludes untracked scratch
 *  files without needing a denylist that can drift. */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
}

const SKIP_PREFIXES = [
  'plans/', // historical design records: they describe what was true when written
  '.agents/', // vendored from the skills repo; editing here would only drift from source
  '.claude/',
]

// No `svg` here on purpose: SVG is text (XML), and the tracked ones include assets/deploy-button.svg
// and the template logos, any of which could embed a stale repo URL. Skipping them would be the
// same blind spot this test exists to close.
const BINARY = /\.(png|jpe?g|gif|ico|woff2?|ttf|zip|gz|tar|pdf|webp|mp4)$/i

const scanned = (): string[] =>
  trackedFiles().filter(
    (p) => !SKIP_PREFIXES.some((s) => p.startsWith(s)) && !BINARY.test(p) && !p.endsWith('package-lock.json'),
  )

/** Every exception is a place the OLD slug is still the CORRECT string. */
function isAllowed(path: string, line: string): boolean {
  // Template manifests keep `sourceRepo:` on the old slug on purpose: it is metadata nothing
  // resolves through, and editing a published template's manifest forces a version bump, which
  // republishes its image and shows "update available" on every deployed instance.
  if (/^(templates|e2e\/fixtures)\/[^/]+\/insta\.template\.yaml$/.test(path)) {
    return /^\s*sourceRepo:/.test(line)
  }
  // Fixtures standing in for READMEs already published in the wild, proving the deploy-badge
  // stripper stays slug-agnostic. Narrowed to the badge URL itself rather than the whole file, so
  // an unrelated stale repo URL added to this test later is still caught.
  if (path === 'templates/scripts/publish-lib.test.mjs') {
    return /cdn\.jsdelivr\.net\/gh\/InsForge\/insta-oss@/.test(line)
  }
  return false
}

/** The two places the old product name is still the CORRECT string. Both are installed or
 *  protocol state rather than a label: the WWW-Authenticate realm a client may already be pinned
 *  to, and the pg_hba.conf marker postgres.ts writes into live databases and then greps for. */
function isProseAllowed(path: string, line: string): boolean {
  if (path === 'src/auth.ts') return /realm="insta-oss"/.test(line)
  if (path === 'src/adapters/postgres.ts') return /insta-oss basebackup/.test(line)
  return false
}

function offendersFor(re: RegExp, paths: string[], allow: (p: string, l: string) => boolean): string[] {
  const out: string[] = []
  for (const path of paths) {
    let text: string
    try { text = readFileSync(join(ROOT, path), 'utf8') } catch { continue }
    if (!re.test(text)) continue
    text.split('\n').forEach((line, i) => {
      if (!re.test(line) || allow(path, line)) return
      out.push(`${path}:${i + 1}: ${line.trim().slice(0, 110)}`)
    })
  }
  return out
}

describe('repo slugs', () => {
  it('ships no URL pointing at a pre-rename repo name', () => {
    const offenders = offendersFor(OLD_SLUG, scanned(), isAllowed)
    expect(offenders, `old repo slugs must use the instacloud-* names:\n${offenders.join('\n')}`).toEqual([])
  })

  // The product is "InstaCloud OSS" in user-facing prose. The first pass at this missed four doc
  // pages, because the check filtered out whole LINES containing "InsForge/" and those four carried
  // the prose and a repo URL on the same line: a false clean. So this matches on the occurrence,
  // never the line.
  it('calls the product InstaCloud OSS in user-facing prose', () => {
    // WHOLE source and doc trees, not a hand-listed set of files. The previous version listed only
    // src/server.ts, the one backend file already fixed, so the identical miss survived in
    // src/auth.ts and src/main.ts. A guard shaped around what you already fixed proves nothing.
    const prose = scanned().filter(
      (p) =>
        p.startsWith('docs/') ||
        p.startsWith('src/') ||
        p.startsWith('ui/') ||
        ['README.md', 'COMPATIBILITY.md', 'CONTRIBUTING.md'].includes(p),
    )
    const offenders = offendersFor(OLD_PRODUCT, prose, isProseAllowed)
    expect(offenders, `use "InstaCloud OSS" for the product name:\n${offenders.join('\n')}`).toEqual([])
  })

  it('still guards the file whose fallback the rename sweep originally missed', () => {
    const publish = readFileSync(join(ROOT, 'templates/scripts/publish.mjs'), 'utf8')
    expect(publish).toContain('const DEFAULT_REPO = "InsForge/instacloud-oss"')
    // `||`, not `??`: an explicitly exported GITHUB_REPOSITORY="" is empty but not nullish, and
    // would otherwise build `cdn.jsdelivr.net/gh/@<sha>/…`.
    expect(publish).not.toMatch(/GITHUB_REPOSITORY\s*\?\?/)
    expect(publish.match(/GITHUB_REPOSITORY \|\| DEFAULT_REPO/g)).toHaveLength(2)
  })

  it('scans the tracked .github tree, where a stale workflow URL would hide', () => {
    expect(scanned().some((p) => p.startsWith('.github/'))).toBe(true)
  })

  // The documented install command has to be one that resolves. get.instacloud.com is NXDOMAIN and
  // always has been, yet it was the headline one-liner in nine places, so the first command a new
  // user copied failed with "could not resolve host". When that host is finally served, promoting
  // it back is deliberate: delete this assertion in the same commit.
  it('documents an install command whose host resolves', () => {
    const docs = scanned().filter(
      (p) => p.startsWith('docs/') || p === 'README.md' || p === 'install.sh',
    )
    const dead = offendersFor(/get\.instacloud\.com/, docs, () => false)
    expect(dead, `get.instacloud.com does not resolve; use the raw URL:\n${dead.join('\n')}`).toEqual([])
    // The one-liner now appears in two places (Quick start and Install on a VPS), so a single
    // toContain would stay green while one copy drifts to a pinned or moved path. Require every
    // raw install.sh URL in the README to be the canonical main one, and at least one to exist.
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
    const CANON = 'https://raw.githubusercontent.com/InsForge/instacloud-oss/main/install.sh'
    const urls = readme.match(/https:\/\/raw\.githubusercontent\.com\/InsForge\/instacloud-oss\/\S*?install\.sh/g) ?? []
    expect(urls.length, 'README should document the install command at least once').toBeGreaterThanOrEqual(1)
    for (const u of urls) expect(u, `install URL must be the canonical main one, not ${u}`).toBe(CANON)
  })
})
