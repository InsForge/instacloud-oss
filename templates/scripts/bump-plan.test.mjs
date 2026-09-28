// Turning "2.1.235 -> 2.1.274" into a diff.
//
// The whole difficulty is that a version lives in three or four places per template, in different
// syntax each time, and the set differs by how the template is pinned. Every fixture below is cut
// from a real manifest, including its comments, because the comments are the reason this edits by
// targeted replacement rather than loading and re-dumping the YAML: laya's manifest explains in a
// comment why it pins a commit instead of the PyPI release, and a round trip through js-yaml would
// delete that and every other sentence in the file.
import { describe, it, expect } from 'vitest';
import { applyBump, applyEdits, planBump } from './bump-plan.mjs';

const NPM_MANIFEST = `code: claude-code
version: 0.8.3
maintainer: official

upstream:
  package: "@anthropic-ai/claude-code"
  pinned: "2.1.235"
  license: LicenseRef-Anthropic-Commercial-Terms

services:
  claude-code:
    type: web
    image: ghcr.io/insforge/insta-oss/templates/claude-code:0.8.3   # built from ./Dockerfile
    port: 7681
`;
const NPM_DOCKERFILE = `FROM node:24-bookworm-slim@sha256:3638d9a6
RUN npm install -g @anthropic-ai/claude-code@2.1.235
`;

const UPSTREAM_IMAGE_MANIFEST = `code: n8n
version: 1.3.2

upstream:
  repo: n8n-io/n8n
  image: docker.io/n8nio/n8n
  pinned: "2.36.5"

services:
  n8n:
    type: web
    image: docker.io/n8nio/n8n:2.36.5
`;

describe('planBump: what moves, by kind', () => {
  it('npm: the manifest version, the pin, our image tag and the install line', () => {
    const plan = planBump({
      manifest: NPM_MANIFEST,
      dockerfile: NPM_DOCKERFILE,
      drift: { kind: 'npm', from: '2.1.235', to: '2.1.274', level: 'patch', comparable: true },
    });
    expect(plan.version).toEqual({ from: '0.8.3', to: '0.8.4' });
    const out = applyEdits({ manifest: NPM_MANIFEST, dockerfile: NPM_DOCKERFILE }, plan.edits);
    expect(out.manifest).toContain('version: 0.8.4');
    expect(out.manifest).toContain('pinned: "2.1.274"');
    // Our own tag follows the TEMPLATE version, never the upstream's: they are different numbers
    // and the image workflow pushes ghcr from this field.
    expect(out.manifest).toContain('templates/claude-code:0.8.4');
    expect(out.dockerfile).toContain('@anthropic-ai/claude-code@2.1.274');
  });

  it('npm: keeps every comment, which is why this does not round-trip the yaml', () => {
    const plan = planBump({ manifest: NPM_MANIFEST, dockerfile: NPM_DOCKERFILE, drift: { kind: 'npm', from: '2.1.235', to: '2.1.274', level: 'patch' } });
    const out = applyEdits({ manifest: NPM_MANIFEST, dockerfile: NPM_DOCKERFILE }, plan.edits);
    expect(out.manifest).toContain('# built from ./Dockerfile');
    expect(out.manifest).toContain('license: LicenseRef-Anthropic-Commercial-Terms');
  });

  it('an upstream image we deploy directly: the service tag is THEIR version, not ours', () => {
    const plan = planBump({
      manifest: UPSTREAM_IMAGE_MANIFEST,
      drift: { kind: 'docker-tag', from: '2.36.5', to: '2.41.3', level: 'minor', comparable: true },
    });
    expect(plan.version).toEqual({ from: '1.3.2', to: '1.4.0' });
    const out = applyEdits({ manifest: UPSTREAM_IMAGE_MANIFEST }, plan.edits);
    expect(out.manifest).toContain('version: 1.4.0');
    expect(out.manifest).toContain('pinned: "2.41.3"');
    expect(out.manifest).toContain('image: docker.io/n8nio/n8n:2.41.3');
  });

  it('bumps our version by the level the upstream moved', () => {
    const at = (level) => planBump({ manifest: NPM_MANIFEST, dockerfile: NPM_DOCKERFILE, drift: { kind: 'npm', from: '2.1.235', to: '9.9.9', level } }).version.to;
    expect(at('patch')).toBe('0.8.4');
    expect(at('minor')).toBe('0.9.0');
    expect(at('major')).toBe('1.0.0');
    // A commit sha has no level. Ours moves by a patch, because it did move and version-guard
    // requires it to, and claiming a minor for a change we cannot size would be an invention.
    expect(at(null)).toBe('0.8.4');
  });
});

describe('planBump: the pin lives in whichever field holds it', () => {
  // laya keeps a commit AND a PyPI release, so only the commit moves. whisper-turbo has no
  // `commit` at all and keeps its sha in `pinned`, and hard-coding `commit` for the git kind
  // refused it outright, which is one of the templates this is supposed to serve.
  const WHISPER = `code: whisper-turbo
version: 0.1.0

upstream:
  repo: baryhuang/whisper-turbo.c
  pinned: 54ad979a08e654929186b374d266a4ced291f1be
`;
  const OLD = '54ad979a08e654929186b374d266a4ced291f1be';
  const NEW = 'ffff979a08e654929186b374d266a4ced291f1be';

  it('moves a sha that lives in pinned, because whisper-turbo has no commit field', () => {
    const plan = planBump({ manifest: WHISPER, dockerfile: `ARG C=${OLD}\n`, drift: { kind: 'git-commit', from: OLD, to: NEW, level: null } });
    expect(plan.error).toBeUndefined();
    const out = applyEdits({ manifest: WHISPER, dockerfile: `ARG C=${OLD}\n` }, plan.edits);
    expect(out.manifest).toContain(`pinned: ${NEW}`);
    expect(out.dockerfile).toBe(`ARG C=${NEW}\n`);
  });

  it('moves the commit and leaves the release alone when both are there', () => {
    // laya's release number is what upstream published, and a new commit does not mean they cut
    // one, so inventing a bump for it would be putting a number in that nobody released.
    const laya = `code: laya
version: 0.2.0

upstream:
  repo: tonychang04/laya-template
  commit: ${OLD}
  pinned: "0.3.4"
`;
    const plan = planBump({ manifest: laya, dockerfile: `ARG LAYA_COMMIT=${OLD}\n`, drift: { kind: 'git-commit', from: OLD, to: NEW, level: null } });
    const out = applyEdits({ manifest: laya, dockerfile: `ARG LAYA_COMMIT=${OLD}\n` }, plan.edits);
    expect(out.manifest).toContain(`commit: ${NEW}`);
    expect(out.manifest).toContain('pinned: "0.3.4"');
  });
});

describe('planBump: what it refuses', () => {
  it('refuses a drift it was not given enough to apply', () => {
    expect(planBump({ manifest: NPM_MANIFEST, drift: null })?.error).toBeTruthy();
    expect(planBump({ manifest: NPM_MANIFEST, drift: { kind: 'npm', unknown: 'nope' } })?.error).toBeTruthy();
  });

  it('refuses when the manifest does not say what the drift claims it says', () => {
    // The detector read the manifest at some earlier moment. If the file has moved since, the safe
    // answer is to do nothing and be re-run, not to edit around the surprise.
    const out = planBump({ manifest: NPM_MANIFEST, dockerfile: NPM_DOCKERFILE, drift: { kind: 'npm', from: '2.0.0', to: '2.1.274', level: 'patch' } });
    expect(out.error).toMatch(/2\.0\.0/);
  });

  it('refuses when a Dockerfile is present and does not name the old pin', () => {
    // Bumping the manifest alone leaves the image built from the old upstream while the catalog
    // advertises the new one. It used to skip the Dockerfile quietly and report the bump applied,
    // which is the exact outcome the rest of this exists to prevent.
    const out = planBump({
      manifest: NPM_MANIFEST,
      dockerfile: 'FROM node:24\nRUN npm install -g @anthropic-ai/claude-code@0.0.0\n',
      drift: { kind: 'npm', from: '2.1.235', to: '2.1.274', level: 'patch' },
    });
    expect(out.error).toMatch(/does not name '2\.1\.235'/);
  });

  it('refuses when the old pin is only in a comment', () => {
    // `# bumped from 2.1.235` over an install line that has already moved on is the most natural
    // sentence to write while bumping by hand. It used to rewrite the COMMENT, bump the manifest
    // and the image tag, and report a synchronized move that had not happened, leaving the build
    // on the other version with nothing disagreeing.
    const out = planBump({
      manifest: NPM_MANIFEST,
      dockerfile: '# previously pinned at 2.1.235\nRUN npm install -g @anthropic-ai/claude-code@2.0.0\n',
      drift: { kind: 'npm', from: '2.1.235', to: '2.1.274', level: 'patch' },
    });
    expect(out.error).toMatch(/in any instruction/);
  });

  it('refuses when the pin is in both a comment and the instruction', () => {
    // Two occurrences, and replacing either blind is a guess. applyEdits is what says so.
    const out = applyBump({
      manifest: NPM_MANIFEST,
      dockerfile: '# pinned at 2.1.235\nRUN npm install -g @anthropic-ai/claude-code@2.1.235\n',
      drift: { kind: 'npm', from: '2.1.235', to: '2.1.274', level: 'patch' },
    });
    expect(out.refused).toMatch(/appears 2 times/);
  });

  it('ignores a commented-out FROM when finding the one that builds', () => {
    const manifest = UPSTREAM_IMAGE_MANIFEST.replace('image: docker.io/n8nio/n8n:2.36.5', 'image: ghcr.io/insforge/insta-oss/templates/x:1.3.2');
    const dockerfile = '# FROM docker.io/n8nio/n8n:2.36.5@sha256:old\nFROM docker.io/n8nio/n8n:2.36.5@sha256:aaaa\n';
    const out = applyBump({ manifest, dockerfile, drift: { kind: 'docker-tag', from: '2.36.5', to: '2.41.3', level: 'minor', digest: 'sha256:bbbb' } });
    expect(out.refused).toBeUndefined();
    // The instruction moved and the commented-out line was left exactly as it was: it is a note
    // about the past, not something to keep current.
    expect(out.files.dockerfile).toContain('FROM docker.io/n8nio/n8n:2.41.3@sha256:bbbb');
    expect(out.files.dockerfile).toContain('# FROM docker.io/n8nio/n8n:2.36.5@sha256:old');
  });

  it('refuses a docker-tag move with no digest when the Dockerfile pins one', () => {
    // Moving the tag and leaving the digest ships the old image under the new number. If the
    // detector could not resolve the digest, there is no safe edit to make here.
    const manifest = UPSTREAM_IMAGE_MANIFEST.replace('image: docker.io/n8nio/n8n:2.36.5', 'image: ghcr.io/insforge/insta-oss/templates/x:1.3.2');
    const dockerfile = 'FROM docker.io/n8nio/n8n:2.36.5@sha256:aaaa\n';
    const out = planBump({ manifest, dockerfile, drift: { kind: 'docker-tag', from: '2.36.5', to: '2.41.3', level: 'minor' } });
    expect(out.error).toMatch(/digest/i);
  });

  it('moves both halves when the digest is there', () => {
    const manifest = UPSTREAM_IMAGE_MANIFEST.replace('image: docker.io/n8nio/n8n:2.36.5', 'image: ghcr.io/insforge/insta-oss/templates/x:1.3.2');
    const dockerfile = 'FROM docker.io/n8nio/n8n:2.36.5@sha256:aaaa\n';
    const plan = planBump({ manifest, dockerfile, drift: { kind: 'docker-tag', from: '2.36.5', to: '2.41.3', level: 'minor', digest: 'sha256:bbbb' } });
    const out = applyEdits({ manifest, dockerfile }, plan.edits);
    expect(out.dockerfile).toBe('FROM docker.io/n8nio/n8n:2.41.3@sha256:bbbb\n');
  });
});

describe('applyBump', () => {
  // One refusal path, because there used to be two and the caller only handled one. planBump
  // returned an error that got reported; applyEdits threw and escaped the runner mid loop, leaving
  // the templates it had already written on disk and printing no report at all.
  it('reports an ambiguous target as a refusal, not by throwing', () => {
    // pi's shape after someone adds `# pinned at 0.84.2 for now` to the Dockerfile: the version
    // is now in there twice and neither occurrence is safe to replace blind.
    const manifest = `code: pi
version: 1.0.0

upstream:
  package: "@earendil-works/pi-coding-agent"
  pinned: "0.84.2"
`;
    const dockerfile = 'RUN npm i -g pi@0.84.2\n# pinned at 0.84.2 for now\n';
    const out = applyBump({ manifest, dockerfile, drift: { kind: 'npm', from: '0.84.2', to: '0.87.1', level: 'minor' } });
    expect(out.refused).toMatch(/appears 2 times/);
    expect(out.files).toBeUndefined();
  });

  it('passes a planner refusal through unchanged', () => {
    const out = applyBump({ manifest: 'version: 1.0.0\n', dockerfile: 'FROM x\n', drift: { kind: 'npm', from: '9.9.9', to: '9.9.10', level: 'patch' } });
    expect(out.refused).toBeTruthy();
    expect(out.files).toBeUndefined();
  });

  it('returns the files and the version when it can', () => {
    const out = applyBump({ manifest: NPM_MANIFEST, dockerfile: NPM_DOCKERFILE, drift: { kind: 'npm', from: '2.1.235', to: '2.1.274', level: 'patch' } });
    expect(out.refused).toBeUndefined();
    expect(out.version).toEqual({ from: '0.8.3', to: '0.8.4' });
    expect(out.files.manifest).toContain('pinned: "2.1.274"');
  });
});

describe('applyEdits', () => {
  it('refuses an edit whose target is not in the file exactly once', () => {
    const twice = 'version: 1.0.0\nother: 1.0.0\n';
    expect(() => applyEdits({ manifest: twice }, [{ file: 'manifest', find: '1.0.0', replace: '1.0.1', why: 'x' }]))
      .toThrow(/appears 2 times/);
    expect(() => applyEdits({ manifest: 'a\n' }, [{ file: 'manifest', find: 'missing', replace: 'x', why: 'y' }]))
      .toThrow(/not in/i);
  });

  it('touches only the files the plan names', () => {
    const out = applyEdits({ manifest: 'version: 1.0.0\n', dockerfile: 'FROM x\n' },
      [{ file: 'manifest', find: 'version: 1.0.0', replace: 'version: 1.0.1', why: 'x' }]);
    expect(out.dockerfile).toBe('FROM x\n');
  });
});
