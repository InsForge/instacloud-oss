// Has the upstream moved, and by how much.
//
// Every case here exists because the registry already contains the shape it describes. The noise
// cases are not hypothetical: codex published 365 versions in one week, almost all per-platform
// alphas, and n8n's 25 most recently updated docker tags are all nightlies. A checker that took
// "the newest thing" from either would propose `0.159.0-alpha.9-win32-arm64` and
// `v3-nightly-20260927`, and open a pull request against a template on the strength of it.
import { describe, it, expect } from 'vitest';
import { compareVersions, kindOf, resolveUpstream, tagDigest, upstreamDrift } from './upstream-check.mjs';

/** A fetch that answers from a map of url-substring to body, and refuses anything else. */
const serving = (routes) => async (url) => {
  const hit = Object.keys(routes).find((k) => String(url).includes(k));
  if (!hit) throw new Error(`no fixture for ${url}`);
  const body = routes[hit];
  if (body === 404) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => body };
};

describe('kindOf', () => {
  // `repo` is on nine of the ten manifests and is never the discriminator: it says where the
  // project lives, not how it is pinned. `image` says the upstream publishes one, which is not the
  // same as us deploying it: 9router, hermes and openclaw all declare one and build their own on
  // top of it, and only n8n deploys the upstream image directly.
  it.each([
    [{ package: '@anthropic-ai/claude-code', pinned: '2.1.235' }, 'npm'],
    [{ repo: 'openai/codex', package: '@openai/codex', pinned: '0.148.0' }, 'npm'],
    [{ repo: 'n8n-io/n8n', image: 'docker.io/n8nio/n8n', pinned: '2.36.5' }, 'docker-tag'],
    [{ repo: 'decolua/9router', image: 'docker.io/decolua/9router', pinned: '0.5.55' }, 'docker-tag'],
    [{ image: 'ghcr.io/openclaw/openclaw', pinned: 'latest@sha256:2f5ce8' }, 'docker-digest'],
    [{ repo: 'tonychang04/laya-template', commit: 'c9dcaab6da74ce5c34a66ef84f2503c77e4e619a', pinned: '0.3.4' }, 'git-commit'],
    [{ repo: 'baryhuang/whisper-turbo.c', pinned: '54ad979a08e654929186b374d266a4ced291f1be' }, 'git-commit'],
  ])('reads %o as %s', (upstream, kind) => {
    expect(kindOf(upstream).kind).toBe(kind);
  });

  it('refuses to guess when nothing says how it is pinned', () => {
    expect(kindOf({ repo: 'a/b', pinned: 'somehow' }).unknown).toMatch(/cannot tell/i);
    expect(kindOf({}).unknown).toBeTruthy();
  });
});

describe('compareVersions', () => {
  it('orders the shapes the registry actually uses', () => {
    expect(compareVersions('2.1.235', '2.1.283')).toBeLessThan(0);
    expect(compareVersions('v2026.8.27', 'v2026.9.1')).toBeLessThan(0);   // hermes, v-prefixed
    expect(compareVersions('0.84.2', '0.84.2')).toBe(0);
    expect(compareVersions('3.0.0', '2.36.5')).toBeGreaterThan(0);        // n8n's coming major
  });

  it('puts a prerelease below the release it leads to', () => {
    // dsh is pinned at 0.1.1-rc.2, so this ordering decides whether it ever moves.
    expect(compareVersions('0.1.1-rc.2', '0.1.1')).toBeLessThan(0);
    expect(compareVersions('0.1.1-rc.2', '0.1.1-rc.3')).toBeLessThan(0);
  });

  it('answers null rather than a guess for anything it cannot parse', () => {
    expect(compareVersions('latest@sha256:2f5ce8', '2.0.0')).toBeNull();
    expect(compareVersions('54ad979a', '54ad979b')).toBeNull();
  });
});

describe('resolveUpstream: npm', () => {
  const npm = (tags) => serving({ 'registry.npmjs.org': { 'dist-tags': tags } });

  it('takes stable over latest, because the maintainer published both', () => {
    // claude-code really does publish both, and they differ: stable 2.1.274, latest 2.1.283.
    const deps = { fetchImpl: npm({ stable: '2.1.274', latest: '2.1.283', next: '2.1.283' }) };
    return expect(resolveUpstream({ package: 'x', pinned: '2.1.235' }, deps)).resolves.toMatchObject({ current: '2.1.274' });
  });

  it('falls back to latest when there is no stable', async () => {
    const deps = { fetchImpl: npm({ latest: '0.84.3' }) };
    expect(await resolveUpstream({ package: 'x', pinned: '0.84.2' }, deps)).toMatchObject({ current: '0.84.3' });
  });

  it('ignores the alpha flood, because it is not in a dist-tag we read', async () => {
    // codex has 5002 versions and 16 dist-tags, most of them per-platform alphas. Reading
    // `latest` collapses all of it to one correct answer.
    const deps = { fetchImpl: npm({ latest: '0.157.1', alpha: '0.159.0-alpha.9', 'alpha-win32-arm64': '0.159.0-alpha.9-win32-arm64', beta: '0.1.2505172116' }) };
    expect(await resolveUpstream({ package: '@openai/codex', pinned: '0.148.0' }, deps)).toMatchObject({ current: '0.157.1' });
  });

  it('refuses a dist-tag that is not a version it can order', async () => {
    // A dist-tag holds whatever the maintainer wrote. Something unorderable would otherwise pass
    // as a "changed, not comparable" move and be pasted into a manifest as a version.
    const deps = { fetchImpl: npm({ latest: 'nightly-20260927' }) };
    expect(await resolveUpstream({ package: 'x', pinned: '1.0.0' }, deps))
      .toMatchObject({ unknown: expect.stringMatching(/not a version/) });
  });

  it('is unknown, not wrong, when the registry answers nothing usable', async () => {
    expect(await resolveUpstream({ package: 'x', pinned: '1.0.0' }, { fetchImpl: serving({ 'registry.npmjs.org': 404 }) })).toHaveProperty('unknown');
    expect(await resolveUpstream({ package: 'x', pinned: '1.0.0' }, { fetchImpl: npm({}) })).toHaveProperty('unknown');
  });
});

describe('resolveUpstream: docker', () => {
  // The registry API: a pull token, then the whole tag list in one answer. Docker Hub's browse
  // endpoint is still where a single tag's digest is read, so a fixture needs both.
  const hub = (names, digest = `sha256:${'a'.repeat(64)}`) => serving({
    'auth.docker.io': { token: 'anonymous' },
    '/tags/list': { tags: names },
    'hub.docker.com': { digest },
  });

  it('keeps only strict X.Y.Z and takes the highest', async () => {
    // Sorted by last_updated, n8n's newest 25 tags are all nightlies. Only the filter saves this.
    const tags = ['v3-nightly-20260927', 'v3-nightly-pc-arm64', 'nightly', 'latest', '2.36.5', '2.37.0', '2.36', '2.37.0-rc.1'];
    expect(await resolveUpstream({ image: 'docker.io/n8nio/n8n', pinned: '2.36.5' }, { fetchImpl: hub(tags) }))
      .toMatchObject({ current: '2.37.0' });
  });

  it('sees a release Docker Hub would have buried', async () => {
    // Hub paginates by recent activity and refuses an anonymous caller at page 11 with a 403, and
    // n8n has 5531 tags of which only three in the first hundred are plain versions. The registry
    // list is complete in one answer, so a nightly burst cannot hide a release behind it.
    const nightlies = Array.from({ length: 300 }, (_, i) => `v3-nightly-${i}`);
    expect(await resolveUpstream({ image: 'docker.io/n8nio/n8n', pinned: '2.36.5' }, { fetchImpl: hub([...nightlies, '2.41.3', '2.36.5']) }))
      .toMatchObject({ current: '2.41.3' });
  });

  it('is unknown when the registry will not list, rather than answering from nothing', async () => {
    const fetchImpl = serving({ 'auth.docker.io': { token: 't' }, '/tags/list': 404 });
    expect(await resolveUpstream({ image: 'docker.io/x/y', pinned: '0.9.0' }, { fetchImpl })).toHaveProperty('unknown');
  });

  it('drops a digest that is not one', async () => {
    // Whatever the remote says goes into a Dockerfile, so it has to look like a digest first.
    expect(await resolveUpstream({ image: 'docker.io/x/y', pinned: '1.0.0' }, { fetchImpl: hub(['2.0.0'], 'not-a-digest') }))
      .toMatchObject({ current: '2.0.0', digest: null });
  });

  it('is unknown when no tag is a plain version', async () => {
    expect(await resolveUpstream({ image: 'docker.io/x/y', pinned: '1.0.0' }, { fetchImpl: hub(['latest', 'nightly']) }))
      .toHaveProperty('unknown');
  });
});

describe('resolveUpstream: git', () => {
  const HEAD = 'aaaabbbbccccddddeeeeffff0000111122223333';

  it('follows the newest tag when the project publishes them', async () => {
    const deps = { fetchImpl: serving({ '/tags': [{ name: 'v2', commit: { sha: HEAD } }] }) };
    expect(await resolveUpstream({ repo: 'a/b', commit: 'c9dcaab' }, deps)).toMatchObject({ current: HEAD });
  });

  it('falls back to the default branch head when there are no tags', async () => {
    // whisper-turbo's shape: the project releases by pushing, so the branch is the only pin there
    // is, and following it is the same thing we did when we pinned a bare sha.
    const deps = {
      // Most specific first: the helper takes the first key the url contains, and '/repos/a/b'
      // is a substring of the tags and commits urls too.
      fetchImpl: serving({ '/tags': [], '/commits/trunk': { sha: HEAD }, '/repos/a/b': { default_branch: 'trunk' } }),
    };
    expect(await resolveUpstream({ repo: 'a/b', pinned: '54ad979a08e654929186b374d266a4ced291f1be' }, deps))
      .toMatchObject({ current: HEAD });
  });

  it('is unknown when there are neither tags nor a readable branch', async () => {
    const deps = { fetchImpl: serving({ '/tags': [], '/repos/a/b': {} }) };
    expect(await resolveUpstream({ repo: 'a/b', commit: 'c9dcaab' }, deps)).toHaveProperty('unknown');
  });
});

describe('tagDigest', () => {
  it('answers what a named tag points at', async () => {
    const deps = { fetchImpl: serving({ '/tags/0.5.55': { digest: `sha256:${'f'.repeat(64)}` } }) };
    expect(await tagDigest('docker.io/decolua/9router', '0.5.55', deps)).toEqual({ digest: `sha256:${'f'.repeat(64)}` });
  });

  it('is unknown off docker.io rather than a guess', async () => {
    expect(await tagDigest('ghcr.io/openclaw/openclaw', 'latest', {})).toHaveProperty('unknown');
  });
});

describe('upstreamDrift', () => {
  const npmAt = (v) => ({ fetchImpl: serving({ 'registry.npmjs.org': { 'dist-tags': { latest: v } } }) });

  it('reports the move when there is one', async () => {
    expect(await upstreamDrift({ package: 'x', pinned: '2.1.235' }, npmAt('2.1.283')))
      .toMatchObject({ kind: 'npm', from: '2.1.235', to: '2.1.283' });
  });

  it('says nothing when the pin is already current', async () => {
    expect(await upstreamDrift({ package: 'x', pinned: '2.1.283' }, npmAt('2.1.283'))).toBeNull();
  });

  it('never proposes a downgrade, whatever the registry says', async () => {
    // A yanked release or a registry hiccup can make `latest` go backwards. Moving a template back
    // on its own would be worse than being behind, and unlike being behind nobody would expect it.
    expect(await upstreamDrift({ package: 'x', pinned: '2.1.283' }, npmAt('2.1.235'))).toBeNull();
  });

  it('carries the bump level, because a major is not a routine update', async () => {
    expect(await upstreamDrift({ image: 'docker.io/n8nio/n8n', pinned: '2.36.5' },
      { fetchImpl: serving({ 'auth.docker.io': { token: 't' }, '/tags/list': { tags: ['3.0.0', '2.36.5'] }, 'hub.docker.com': { digest: `sha256:${'a'.repeat(64)}` } }) }))
      .toMatchObject({ level: 'major', to: '3.0.0' });
    expect(await upstreamDrift({ package: 'x', pinned: '2.1.235' }, npmAt('2.1.283'))).toMatchObject({ level: 'patch' });
  });

  it('marks a change it cannot order rather than calling it forward', async () => {
    // A commit sha and a digest have no ordering: a force-push moves HEAD backwards and looks
    // identical to moving it forwards. Reporting it as "changed" is honest, calling it an upgrade
    // is not, and the difference is what a person needs in order to decide.
    const moved = await upstreamDrift(
      { repo: 'a/b', pinned: '54ad979a08e654929186b374d266a4ced291f1be' },
      { fetchImpl: serving({ 'api.github.com': [{ name: 'v2', commit: { sha: 'aaaabbbbccccddddeeeeffff0000111122223333' } }] }) },
    );
    expect(moved).toMatchObject({ comparable: false });
    expect(moved.level).toBeNull();
  });

  it('carries the digest of the tag it picked, because a tag alone is half a pin', async () => {
    // 9router, hermes and openclaw write FROM <image>:<tag>@sha256:<digest>. Moving the tag and
    // leaving the digest is the worst outcome available: docker prefers the digest, so the build
    // succeeds and ships the old image while the manifest and the catalog claim the new version.
    const out = await upstreamDrift({ image: 'docker.io/decolua/9router', pinned: '0.5.55' }, {
      fetchImpl: serving({ 'auth.docker.io': { token: 't' }, '/tags/list': { tags: ['0.5.91', '0.5.55'] }, 'hub.docker.com': { digest: `sha256:${'e'.repeat(64)}` } }),
    });
    expect(out).toMatchObject({ to: '0.5.91', digest: `sha256:${'e'.repeat(64)}` });
  });

  it('passes an unresolvable upstream through as unknown, and proposes nothing', async () => {
    const out = await upstreamDrift({ package: 'x', pinned: '1.0.0' }, { fetchImpl: serving({ 'registry.npmjs.org': 404 }) });
    expect(out.unknown).toBeTruthy();
    expect(out.to).toBeUndefined();
  });
});
