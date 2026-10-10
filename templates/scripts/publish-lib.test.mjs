import { describe, expect, it } from 'vitest'
import { DEPLOY_BUTTON_ASSET, findDeployButtons, ghcrGateMessage, ghcrRetryVerdict, parseGhcrRef, repoPathOf, rewriteReadme, stripDeployBadge } from './publish-lib.mjs'

const SHA = 'a'.repeat(40)
const REPO = 'InsForge/instacloud-oss'
const DIR = 'templates/example'
const cdn = (p) => `https://cdn.jsdelivr.net/gh/${REPO}@${SHA}/${p}`

// The rewriter is told which resolved paths are directories, so these tests need no filesystem.
const rewrite = (text, isDirectory = () => false) =>
  rewriteReadme(text, { dirInRepo: DIR, repo: REPO, sha: SHA, isDirectory })

describe('parseGhcrRef', () => {
  it('splits a multi-segment name from its tag', () => {
    expect(parseGhcrRef('ghcr.io/insforge/insta-oss/templates/codex:0.3.0'))
      .toEqual({ repo: 'insforge/insta-oss/templates/codex', tag: '0.3.0' })
  })

  it('splits a digest reference', () => {
    expect(parseGhcrRef('ghcr.io/owner/name@sha256:abc'))
      .toEqual({ repo: 'owner/name', tag: 'sha256:abc' })
  })

  it('defaults a tagless reference to latest', () => {
    expect(parseGhcrRef('ghcr.io/owner/name')).toEqual({ repo: 'owner/name', tag: 'latest' })
  })

  it('ignores registries it does not gate', () => {
    expect(parseGhcrRef('docker.io/n8nio/n8n:2.10.2')).toBeNull()
    expect(parseGhcrRef(undefined)).toBeNull()
  })
})

describe('ghcrGateMessage', () => {
  const base = { name: 'workspace', ref: 'ghcr.io/o/n:1', anon: 403 }

  it('names package visibility when the image exists but is not anonymous', () => {
    const msg = ghcrGateMessage({ ...base, auth: 0 })
    expect(msg).toContain('NOT anonymously pullable')
    expect(msg).toContain('Change visibility')
    // The operator must not be sent looking for a build that already succeeded.
    expect(msg).not.toContain('not published yet')
  })

  it('offers both causes when the authenticated probe also failed', () => {
    const msg = ghcrGateMessage({ ...base, auth: 404 })
    expect(msg).toContain('authenticated HTTP 404')
    expect(msg).toContain('not published yet')
  })

  it('says so when there was no token to classify with', () => {
    expect(ghcrGateMessage({ ...base, auth: null })).toContain('no GHCR_TOKEN was set')
  })
})

describe('rewriteReadme', () => {
  it('sends relative images to the CDN, in every spelling', () => {
    const out = rewrite([
      '![a](./shot.png)',
      '![b](shot.png)',
      '![c](./shot.png "a title")',
      '![d](./shot.png#frag)',
      '<img src="./shot.png" width="200">',
      "<img src='shot.png'>",
    ].join('\n'))
    expect(out).toBe([
      `![a](${cdn(`${DIR}/shot.png`)})`,
      `![b](${cdn(`${DIR}/shot.png`)})`,
      `![c](${cdn(`${DIR}/shot.png`)} "a title")`,
      `![d](${cdn(`${DIR}/shot.png`)}#frag)`,
      `<img src="${cdn(`${DIR}/shot.png`)}" width="200">`,
      `<img src='${cdn(`${DIR}/shot.png`)}'>`,
    ].join('\n'))
  })

  it('leaves absolute, root-relative and anchor targets alone', () => {
    const text = [
      '![x](https://example.com/a.png)',
      '[y](https://instacloud.com/templates)',
      '[z](#a-heading)',
      '[w](/absolute/path)',
      '[v](mailto:info@insforge.dev)',
    ].join('\n')
    expect(rewrite(text)).toBe(text)
  })

  it('links files with blob and directories with tree', () => {
    const isDirectory = (p) => p === 'templates/hermes'
    const out = rewrite('[doc](../AGENTS.md) [dir](../hermes/) [dir2](../hermes)', isDirectory)
    expect(out).toContain(`https://github.com/${REPO}/blob/${SHA}/templates/AGENTS.md`)
    // A trailing slash is a directory even when the caller cannot stat it...
    expect(out).toContain(`https://github.com/${REPO}/tree/${SHA}/templates/hermes)`)
    // ...and so is a path isDirectory() recognises, which is the deepseek-hermes -> hermes case.
    expect(out.match(new RegExp(`${REPO}/tree/`, 'g'))).toHaveLength(2)
    expect(out).not.toContain(`blob/${SHA}/templates/hermes`)
  })

  it('refuses an image that reaches outside its own template directory', () => {
    expect(() => rewrite('![x](../hermes/logo.png)')).toThrow(/points outside the template directory/)
  })

  it('refuses a target that climbs out of the repository', () => {
    expect(() => rewrite('[x](../../../etc/passwd)')).toThrow(/escapes the repository/)
  })

  it('publishes the text unchanged when there is nothing to rewrite', () => {
    const text = '# Title\n\nPlain prose with `code` and a list:\n\n- one\n- two\n'
    expect(rewrite(text)).toBe(text)
  })
})

// The bug this encodes: publish and templates-build-images run on the same push,
// so publish reliably sees the anonymous 403 of a package the build has not
// pushed yet. Reading that as "private" is what failed every image-bumping merge.
describe('ghcrRetryVerdict', () => {
  it('waits when the authenticated probe says the image is not there yet', () => {
    expect(ghcrRetryVerdict({ anon: 403, auth: 404 })).toBe('retry')
    expect(ghcrRetryVerdict({ anon: 401, auth: 404 })).toBe('retry')
  })

  it('gives up when the image exists but is hidden', () => {
    // 0 is this script's "resolved" status, so an authenticated hit means private.
    expect(ghcrRetryVerdict({ anon: 403, auth: 0 })).toBe('fatal')
    expect(ghcrRetryVerdict({ anon: 401, auth: 0 })).toBe('fatal')
  })

  it('waits when nothing authenticated an answer', () => {
    expect(ghcrRetryVerdict({ anon: 403, auth: null })).toBe('retry')
    expect(ghcrRetryVerdict({ anon: 403, auth: undefined })).toBe('retry')
  })

  it('waits when the authenticated probe itself failed to classify', () => {
    // An expired or under-scoped token, or ghcr rate limiting, proves nothing
    // about visibility; only a probe that resolves does.
    expect(ghcrRetryVerdict({ anon: 403, auth: 401 })).toBe('retry')
    expect(ghcrRetryVerdict({ anon: 403, auth: 403 })).toBe('retry')
    expect(ghcrRetryVerdict({ anon: 403, auth: 429 })).toBe('retry')
    expect(ghcrRetryVerdict({ anon: 403, auth: 500 })).toBe('retry')
  })

  it('leaves every other status to the caller loop', () => {
    expect(ghcrRetryVerdict({ anon: 404, auth: 0 })).toBe('retry')
    expect(ghcrRetryVerdict({ anon: 500, auth: null })).toBe('retry')
  })
})

describe('stripDeployBadge', () => {
  const button = `[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/insta-oss@main/${DEPLOY_BUTTON_ASSET})](https://instacloud.com/templates/n8n)`

  it('takes the button and the blank line it leaves behind', () => {
    // One blank line has to survive between the tagline and the next section, not two.
    expect(stripDeployBadge(`# n8n\n\nTagline.\n\n${button}\n\n## Overview\n\nBody.\n`))
      .toBe('# n8n\n\nTagline.\n\n## Overview\n\nBody.\n')
  })

  it('handles the button as the last thing in the file', () => {
    expect(stripDeployBadge(`# n8n\n\nTagline.\n\n${button}\n`)).toBe('# n8n\n\nTagline.\n')
  })

  it('leaves a fenced sample of the snippet alone', () => {
    // assets/README.md documents the snippet inside a fence, and the gallery should keep showing
    // it: only a button standing on its own in the prose is an affordance to remove.
    const doc = `# Button\n\nPaste this:\n\n\`\`\`markdown\n${button}\n\`\`\`\n\nDone.\n`
    expect(stripDeployBadge(doc)).toBe(doc)
  })

  it('leaves a README that has no button untouched', () => {
    const text = '# n8n\n\nTagline.\n\n## Overview\n'
    expect(stripDeployBadge(text)).toBe(text)
  })

  it('does not touch an unrelated image or link', () => {
    const text = `# n8n\n\n![shot](./shot.png)\n\n[docs](https://docs.instacloud.com/)\n`
    expect(stripDeployBadge(text)).toBe(text)
  })

  it('matches the button whatever host serves it', () => {
    // The snippet is documented against jsDelivr, but a fork or a short vanity URL should still
    // be recognised: the asset path is what identifies it.
    const short = `[![Deploy on InstaCloud](https://instacloud.com/${DEPLOY_BUTTON_ASSET})](https://instacloud.com/templates/pi)`
    expect(stripDeployBadge(`# pi\n\nTag.\n\n${short}\n\n## Overview\n`)).toBe('# pi\n\nTag.\n\n## Overview\n')
  })
})

describe('stripDeployBadge bounds', () => {
  const url = `https://cdn.jsdelivr.net/gh/InsForge/insta-oss@main/${DEPLOY_BUTTON_ASSET}`
  const button = (u = url) => `[![Deploy on InstaCloud](${u})](https://instacloud.com/templates/n8n)`
  const wrap = (line) => `# n8n\n\nTag.\n\n${line}\n\n## Overview\n`

  it('strips a paragraph indented up to three spaces', () => {
    expect(stripDeployBadge(wrap(`   ${button()}`))).toBe('# n8n\n\nTag.\n\n## Overview\n')
  })

  it('keeps a four-space indent, which is an indented code block', () => {
    // The fence tracking cannot see this spelling of a code sample, so the indent bound is what
    // covers it.
    const text = wrap(`    ${button()}`)
    expect(stripDeployBadge(text)).toBe(text)
  })

  it('keeps a tab indent, which is also an indented code block', () => {
    const text = wrap(`\t${button()}`)
    expect(stripDeployBadge(text)).toBe(text)
  })

  it('keeps a different file whose name merely starts the same', () => {
    const text = wrap(button(`${url}.bak`))
    expect(stripDeployBadge(text)).toBe(text)
  })

  it('keeps an asset that is not the last path segment', () => {
    const text = wrap(button(`https://example.com/my${DEPLOY_BUTTON_ASSET}`))
    expect(stripDeployBadge(text)).toBe(text)
  })

  it('strips one carrying a query or a fragment', () => {
    expect(stripDeployBadge(wrap(button(`${url}?v=2`)))).toBe('# n8n\n\nTag.\n\n## Overview\n')
    expect(stripDeployBadge(wrap(button(`${url}#icon`)))).toBe('# n8n\n\nTag.\n\n## Overview\n')
  })

  it('keeps a fence open when a longer one quotes a shorter one', () => {
    // A four-backtick block quoting a three-backtick sample: the inner line is not a close, so
    // the button inside is still documentation. A parity flip read it as a close and stripped it.
    const doc = `# Docs\n\n\`\`\`\`markdown\n\`\`\`\n${button()}\n\`\`\`\n\`\`\`\`\n\nAfter.\n`
    expect(stripDeployBadge(doc)).toBe(doc)
  })

  it('still strips a real button after a fenced sample has closed', () => {
    const before = `# n8n\n\nTag.\n\n\`\`\`markdown\n${button()}\n\`\`\`\n\n${button()}\n\n## Overview\n`
    expect(stripDeployBadge(before))
      .toBe(`# n8n\n\nTag.\n\n\`\`\`markdown\n${button()}\n\`\`\`\n\n## Overview\n`)
  })

  it('does not let an info string with a backtick open a block', () => {
    // CommonMark: a backtick fence's info string may not contain a backtick, so this line is
    // prose carrying an inline code span, NOT an open fence. The button below it is therefore
    // still a real button and still goes.
    const prose = '```js const a = `x`'
    expect(stripDeployBadge(`# n8n\n\nTag.\n\n${prose}\n\n${button()}\n\n## Overview\n`))
      .toBe(`# n8n\n\nTag.\n\n${prose}\n\n## Overview\n`)
  })
})

describe('findDeployButtons', () => {
  // lint.mjs validates what this returns, so anything it MISSES is a README that could pass CI
  // carrying something publish would leave on the gallery, and anything it invents is a template
  // failing CI over a button it does not have.
  const url = `https://cdn.jsdelivr.net/gh/InsForge/insta-oss@main/${DEPLOY_BUTTON_ASSET}`
  const href = 'https://instacloud.com/templates/n8n'
  const button = (u = url, h = href) => `[![Deploy on InstaCloud](${u})](${h})`
  const wrap = (line) => `# n8n\n\nTag.\n\n${line}\n\n## Overview\n`

  it('returns the href of a real button', () => {
    expect(findDeployButtons(wrap(button()))).toEqual([href])
  })

  it('finds every button, in document order', () => {
    const second = 'https://instacloud.com/templates/pi'
    expect(findDeployButtons(`${wrap(button())}\n${button(url, second)}\n`)).toEqual([href, second])
  })

  it('finds none in a fenced sample', () => {
    expect(findDeployButtons(`# Docs\n\n\`\`\`markdown\n${button()}\n\`\`\`\n`)).toEqual([])
  })

  it('finds none in an indented code block', () => {
    expect(findDeployButtons(wrap(`    ${button()}`))).toEqual([])
  })

  it('finds none when the image is not wrapped in a link', () => {
    expect(findDeployButtons(wrap(`![Deploy on InstaCloud](${url})`))).toEqual([])
  })

  it('finds none for a neighbouring filename', () => {
    expect(findDeployButtons(wrap(button(`${url}.bak`)))).toEqual([])
  })

  it('agrees with stripDeployBadge on the same text', () => {
    // The invariant the two exports exist to keep: a button is found exactly when it is stripped.
    for (const line of [button(), `   ${button()}`, `    ${button()}`, `![x](${url})`, button(`${url}.bak`)]) {
      const text = wrap(line)
      expect(findDeployButtons(text).length > 0).toBe(stripDeployBadge(text) !== text)
    }
  })
})

describe('repoPathOf', () => {
  const ROOT = '/repo'

  it('names a directory the way the repository does, however the caller wrote it', () => {
    for (const written of ['templates/hermes', './templates/hermes', '/repo/templates/hermes']) {
      expect(repoPathOf(written, ROOT)).toBe('templates/hermes')
    }
  })

  it('refuses a directory outside the repository', () => {
    // The real path from the run that minted
    // `.../insta-oss@8b25847//Users/carmen/.claude/jobs/.../hermes/logo.png`,
    // a url the registry still serves and jsDelivr will never resolve.
    expect(() => repoPathOf('/Users/carmen/.claude/jobs/38df30c0/tmp/hermes-staging-test/hermes', ROOT))
      .toThrow(/outside the repository/)
    expect(() => repoPathOf('/repo/../elsewhere/hermes', ROOT)).toThrow(/outside the repository/)
  })

  it('refuses the repository root itself, which names no template', () => {
    expect(() => repoPathOf('/repo', ROOT)).toThrow(/outside the repository/)
  })

  it('builds the url the CDN can actually serve', () => {
    expect(cdn(`${repoPathOf('/repo/templates/hermes', ROOT)}/logo.png`))
      .toBe(`https://cdn.jsdelivr.net/gh/${REPO}@${SHA}/templates/hermes/logo.png`)
  })
})
