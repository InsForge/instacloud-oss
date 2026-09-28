// The upstream version is written twice for every template we build ourselves: once as
// `upstream.pinned` (or `upstream.commit`) in the manifest, and once in the Dockerfile that
// installs or clones it. Nothing checked they agree, so an edit to one and not the other shipped an
// image built from the old version while the catalog advertised the new one, with nothing raising a
// hand. The cases below cover both directions of that drift, because a bot bumping the manifest and
// a person bumping the Dockerfile are equally likely to forget the other half.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { checkDockerfilePin } from './dockerfile-pin.mjs';

const templates = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('checkDockerfilePin', () => {
  it('passes when the pinned version appears in the Dockerfile', () => {
    expect(checkDockerfilePin({ pinned: '2.1.235' }, 'RUN npm install -g @anthropic-ai/claude-code@2.1.235\n')).toBeNull();
  });

  it('passes on the commit alone, which is laya\'s shape', () => {
    // laya pins `0.3.4`, the upstream PyPI release, but the Dockerfile clones a commit, because
    // `pip install laya==0.3.4` does not carry the deploy/app.py the image runs. The release
    // number is the honest answer to "which version is this" and the commit is what builds, so
    // either one appearing is enough.
    const df = 'ARG LAYA_COMMIT=c9dcaab6da74ce5c34a66ef84f2503c77e4e619a\nRUN git checkout "$LAYA_COMMIT"\n';
    expect(checkDockerfilePin({ pinned: '0.3.4', commit: 'c9dcaab6da74ce5c34a66ef84f2503c77e4e619a' }, df)).toBeNull();
  });

  it('fails when the manifest moved and the Dockerfile did not', () => {
    const out = checkDockerfilePin({ pinned: '2.1.283' }, 'RUN npm install -g @anthropic-ai/claude-code@2.1.235\n');
    expect(out?.error).toMatch(/2\.1\.283/);
    expect(out?.error).toMatch(/Dockerfile/);
  });

  it('fails when the Dockerfile moved and the manifest did not', () => {
    // The same check catches the other direction for free: the value the manifest still claims is
    // no longer anywhere in the file.
    expect(checkDockerfilePin({ pinned: '2.1.235' }, 'RUN npm install -g @anthropic-ai/claude-code@2.1.283\n')?.error)
      .toMatch(/2\.1\.235/);
  });

  it('treats a missing pin as missing, not as a match', () => {
    // `"abc".includes("")` is true, so an absent value would otherwise pass every Dockerfile ever
    // written and the rule would be decoration.
    expect(checkDockerfilePin({ pinned: '', commit: undefined }, 'FROM scratch\n')?.error).toBeTruthy();
    expect(checkDockerfilePin({}, 'FROM scratch\n')?.error).toBeTruthy();
  });

  it('accepts whatever shape a pin happens to be', () => {
    // Seven shapes live in the registry today: plain semver, a prerelease, a v-prefixed date, a
    // floating tag with a digest, and a bare sha. The rule asks whether the string is in the file
    // and never what it means, which is the only way one rule covers all of them.
    for (const pinned of ['0.5.55', '0.1.1-rc.2', 'v2026.8.27', 'latest@sha256:2f5ce8848a1a', '54ad979a08e6']) {
      expect(checkDockerfilePin({ pinned }, `ARG V=${pinned}\n`), pinned).toBeNull();
    }
  });
});

describe('the registry as it stands', () => {
  const dirs = readdirSync(templates)
    .filter((t) => existsSync(join(templates, t, 'insta.template.yaml')))
    .filter((t) => existsSync(join(templates, t, 'Dockerfile')));

  it('has templates with a Dockerfile to check', () => {
    expect(dirs.length).toBeGreaterThan(5);
  });

  it.each(dirs)('%s: the Dockerfile names the pin its manifest declares', (t) => {
    const m = yaml.load(readFileSync(join(templates, t, 'insta.template.yaml'), 'utf8'));
    const df = readFileSync(join(templates, t, 'Dockerfile'), 'utf8');
    expect(checkDockerfilePin(m?.upstream ?? {}, df)).toBeNull();
  });

  it.each(dirs)('%s: and would notice if that Dockerfile drifted', (t) => {
    // The mutation the rule exists for, run against every real template rather than a fixture: take
    // the value out of the Dockerfile and the check has to fail. A rule that passes on the repo but
    // also passes on a broken repo is not a rule.
    const m = yaml.load(readFileSync(join(templates, t, 'insta.template.yaml'), 'utf8'));
    const up = m?.upstream ?? {};
    let df = readFileSync(join(templates, t, 'Dockerfile'), 'utf8');
    for (const v of [up.pinned, up.commit].filter(Boolean)) df = df.split(String(v)).join('SOMETHING-ELSE');
    expect(checkDockerfilePin(up, df)?.error).toBeTruthy();
  });
});
