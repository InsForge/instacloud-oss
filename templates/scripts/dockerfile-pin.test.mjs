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
import { checkDockerfilePin, checkUpstreamFrom } from './dockerfile-pin.mjs';

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

  it('does not count a comment as naming the pin', () => {
    // `# bumped from 2.1.235` is the most natural sentence to write while bumping by hand, and it
    // made a Dockerfile whose install line had already diverged look compliant. The manifest would
    // then advertise a version the image does not build, with nothing disagreeing.
    const df = '# previously pinned at 2.1.235\nRUN npm install -g x@2.0.0\n';
    expect(checkDockerfilePin({ pinned: '2.1.235' }, df)?.error).toBeTruthy();
    // And a commented-out FROM is not a FROM.
    const up = { image: 'example/upstream', pinned: '1.2.3' };
    expect(checkUpstreamFrom(up, '# FROM example/upstream:1.2.3\nFROM example/upstream:9.9.9\n')?.error).toMatch(/9\.9\.9/);
  });

  it('does not count an inline comment as naming the pin either', () => {
    // The same sentence, one line up instead of on its own line. Docker keeps it and hands the whole
    // line to the shell, which throws away everything from the ` #` on, so the manifest advertised
    // 2.1.235 while the image installed 9.9.9 and this said they agreed.
    expect(checkDockerfilePin({ pinned: '2.1.235' }, 'RUN npm install -g x@9.9.9 # previously pinned at 2.1.235\n')?.error).toBeTruthy();
    // A continued instruction is ONE line by the time the shell sees it, so a `#` opened before the
    // backslash comments out what follows as well.
    expect(checkDockerfilePin({ pinned: '2.1.235' }, 'RUN true # note \\\n    && npm install -g x@2.1.235\n')?.error).toBeTruthy();
    // A comment LINE inside a continuation is the other way round: docker removes it before joining,
    // so the instruction after it does build and does count.
    expect(checkDockerfilePin({ pinned: '2.1.235' }, 'RUN true \\\n    # a note\n    && npm install -g x@2.1.235\n')).toBeNull();
    // A word may start after an operator as much as after a space, and a `#` there opens a comment
    // just the same. Asking only for whitespace let `;#` through while the shell ignored all of it.
    for (const sep of [';', '&&', '||', '|', ')', '>']) {
      const df = `RUN npm install x@9.9.9${sep}# previously pinned at 1.2.3\n`;
      expect(checkDockerfilePin({ pinned: '1.2.3' }, df)?.error, sep).toBeTruthy();
    }
    // And a `#` that is not a word of its own starts no comment, to the shell or to this.
    expect(checkDockerfilePin({ pinned: '1.2.3' }, 'RUN curl -o x https://example.com/v/1.2.3#sig\n')).toBeNull();
  });

  it('does not read a pin as present inside a longer version', () => {
    // Plain containment reads 1.2.3 as present in 1.2.30, so a template pinned one release behind
    // its Dockerfile passed. A digit or a dot on either side means the match is the middle of
    // something else.
    expect(checkDockerfilePin({ pinned: '1.2.3' }, 'RUN npm i -g x@1.2.30\n')?.error).toBeTruthy();
    expect(checkDockerfilePin({ pinned: '1.2.3' }, 'RUN npm i -g x@11.2.3\n')?.error).toBeTruthy();
    // And the separators a real Dockerfile puts around a version still count as a match.
    for (const line of ['RUN x@1.2.3\n', 'FROM y:1.2.3\n', 'ARG V=1.2.3\n', 'ARG V=v1.2.3\n', 'RUN x 1.2.3\n']) {
      expect(checkDockerfilePin({ pinned: '1.2.3' }, line), line).toBeNull();
    }
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

describe('checkUpstreamFrom', () => {
  // Three templates build on top of the upstream's own image, and all three pin it twice over in
  // the FROM line: a tag and a digest. Moving the manifest and leaving that line behind is the
  // drift the substring rule above already catches, but only by luck of the old value vanishing.
  // This one names the FROM explicitly, and it is scoped to the image the manifest declares so a
  // base image, which every other Dockerfile pins by digest too, is none of its business.
  const from = (ref) => `FROM ${ref}\nRUN true\n`;

  it('passes when the FROM tag is the pinned one', () => {
    const up = { image: 'docker.io/decolua/9router', pinned: '0.5.55' };
    expect(checkUpstreamFrom(up, from('docker.io/decolua/9router:0.5.55@sha256:f00fe389ef41'))).toBeNull();
  });

  it('passes when the pin carries the digest too, and both halves agree', () => {
    // openclaw's shape: the pin IS `latest@sha256:...`, because a floating tag alone would drift.
    const up = { image: 'ghcr.io/openclaw/openclaw', pinned: 'latest@sha256:2f5ce8848a1a' };
    expect(checkUpstreamFrom(up, from('ghcr.io/openclaw/openclaw:latest@sha256:2f5ce8848a1a'))).toBeNull();
  });

  it('fails when the manifest moved and the FROM did not', () => {
    const up = { image: 'docker.io/decolua/9router', pinned: '0.5.91' };
    const out = checkUpstreamFrom(up, from('docker.io/decolua/9router:0.5.55@sha256:f00fe389ef41'));
    expect(out?.error).toMatch(/0\.5\.55/);
    expect(out?.error).toMatch(/0\.5\.91/);
  });

  it('fails when the two digests disagree', () => {
    const up = { image: 'ghcr.io/openclaw/openclaw', pinned: 'latest@sha256:2f5ce8848a1a' };
    expect(checkUpstreamFrom(up, from('ghcr.io/openclaw/openclaw:latest@sha256:999999999999'))?.error)
      .toMatch(/digest/i);
  });

  it('ignores a Dockerfile that never builds on the upstream image', () => {
    // Every other template starts FROM node or debian, pinned by digest. Those are base images and
    // have nothing to do with upstream.pinned, so a rule that looked at any digest-bearing FROM
    // would fail seven templates for being careful.
    expect(checkUpstreamFrom({ package: '@x/y', pinned: '1.0.0' }, from('node:24-bookworm-slim@sha256:3638d9a6'))).toBeNull();
    expect(checkUpstreamFrom({ image: 'docker.io/decolua/9router', pinned: '0.5.55' }, from('debian:bookworm-slim@sha256:3783cc01'))).toBeNull();
  });

  it('checks every stage, because docker builds the last one', () => {
    // An early stage that agrees proves nothing about the stage the image actually comes from.
    // Returning at the first match let `FROM upstream:1.2.3 AS old` vouch for a stale final stage,
    // and whisper-turbo is already multi-stage, so this is a shape the registry contains.
    const up = { image: 'example/upstream', pinned: '1.2.3' };
    const df = 'FROM example/upstream:1.2.3 AS old\nRUN true\nFROM example/upstream:9.9.9\n';
    expect(checkUpstreamFrom(up, df)?.error).toMatch(/9\.9\.9/);
  });

  it('reads past the flags a FROM may carry', () => {
    // `--platform` was being read as the image, so the whole instruction was skipped and a drifted
    // pin behind one was invisible.
    const up = { image: 'example/upstream', pinned: '1.2.3' };
    expect(checkUpstreamFrom(up, 'FROM --platform=linux/amd64 example/upstream:9.9.9\n')?.error).toMatch(/9\.9\.9/);
    expect(checkUpstreamFrom(up, 'FROM --platform=$BUILDPLATFORM example/upstream:1.2.3 AS b\n')).toBeNull();
  });

  it('joins a continued FROM, because an instruction is not a line', () => {
    // `FROM --platform=... \\` continued on the next line is one instruction to docker and was two
    // to a scanner reading physical lines, so the reference that actually builds sat somewhere
    // this never looked.
    const up = { image: 'example/upstream', pinned: '1.2.3' };
    const df = ['FROM --platform=linux/amd64 \\', '    example/upstream:9.9.9', ''].join('\n');
    expect(checkUpstreamFrom(up, df)?.error).toMatch(/9\.9\.9/);
  });

  it('reads a short Docker Hub name as the image it resolves to', () => {
    // `decolua/9router` and `docker.io/decolua/9router` are one image to docker and were two strings
    // here, so a FROM written short matched nothing, the instruction was skipped, and the drifted tag
    // behind it was invisible while an unrelated ARG satisfied the substring rule on its own.
    const up = { image: 'docker.io/decolua/9router', pinned: '0.5.55' };
    expect(checkUpstreamFrom(up, 'ARG EXPECTED=0.5.55\nFROM decolua/9router:9.9.9\n')?.error).toMatch(/9\.9\.9/);
    expect(checkUpstreamFrom(up, from('decolua/9router:0.5.55'))).toBeNull();
    expect(checkUpstreamFrom(up, from('index.docker.io/decolua/9router:0.5.55'))).toBeNull();
    // An official image carries an implicit `library` namespace, so both spellings are one image too.
    expect(checkUpstreamFrom({ image: 'docker.io/library/postgres', pinned: '17.2' }, from('postgres:9.9'))?.error).toMatch(/17\.2/);
    // A host-looking first segment is still a host, so this is not the same image as the one above.
    expect(checkUpstreamFrom(up, from('ghcr.io/decolua/9router:9.9.9'))).toBeNull();
  });

  it('continues a line with whatever the parser directive says continues it', () => {
    // `# escape=`` ` `` is a directive, not a comment. Dropped with the comments and assumed to be a
    // backslash, the backtick itself was read as the image, so the reference on the next line was
    // never looked at and an unrelated ARG carried the substring rule on its own.
    const up = { image: 'example/upstream', pinned: '1.2.3' };
    const tick = ['# escape=`', 'FROM --platform=linux/amd64 `', '    example/upstream:9.9.9', 'ARG EXPECTED=1.2.3', ''].join('\n');
    expect(checkUpstreamFrom(up, tick)?.error).toMatch(/9\.9\.9/);
    expect(checkUpstreamFrom(up, ['# escape=`', 'FROM example/upstream:1.2.3 `', '    AS b', ''].join('\n'))).toBeNull();
    // A directive that is not `escape` leaves the backslash alone, and so does a plain comment.
    const syn = ['# syntax=docker/dockerfile:1', 'FROM --platform=linux/amd64 \\', '    example/upstream:9.9.9', ''].join('\n');
    expect(checkUpstreamFrom(up, syn)?.error).toMatch(/9\.9\.9/);
  });

  it('resolves a tag the Dockerfile keeps in a build arg', () => {
    // `ARG VERSION=1.2.3` above `FROM example/upstream:${VERSION}` is an ordinary Dockerfile and was
    // reported as drift, because the literal text `${VERSION}` was compared with the pin. Expanding
    // first removes the false alarm and catches the arg that has actually moved.
    const up = { image: 'example/upstream', pinned: '1.2.3' };
    expect(checkUpstreamFrom(up, 'ARG VERSION=1.2.3\nFROM example/upstream:${VERSION}\n')).toBeNull();
    expect(checkUpstreamFrom(up, 'ARG VERSION=1.2.3\nFROM example/upstream:$VERSION\n')).toBeNull();
    expect(checkUpstreamFrom(up, 'ARG VERSION=9.9.9\nFROM example/upstream:${VERSION}\n')?.error).toMatch(/9\.9\.9/);
    // Nothing declares it, so the version this image gets is decided at build time, not here.
    expect(checkUpstreamFrom(up, 'ARG VERSION\nFROM example/upstream:${VERSION}\n')?.error).toMatch(/build time/);
  });

  it('only lets a build arg declared before the first FROM decide a FROM', () => {
    // Docker calls those global. An ARG inside a stage belongs to that stage and cannot reach back
    // out, so reading the whole file into one map applied a later declaration retroactively: this
    // builds from 9.9.9 and was checked against the 1.2.3 declared underneath it.
    const up = { image: 'example/upstream', pinned: '1.2.3' };
    const after = 'ARG VERSION=9.9.9\nFROM example/upstream:${VERSION}\nARG VERSION=1.2.3\n';
    expect(checkUpstreamFrom(up, after)?.error).toMatch(/9\.9\.9/);
    // Redeclared before the first FROM, the last one is what the FROM gets.
    expect(checkUpstreamFrom(up, 'ARG VERSION=9.9.9\nARG VERSION=1.2.3\nFROM example/upstream:${VERSION}\n')).toBeNull();
    // A stage may shadow the name for itself without changing what a later FROM resolves to.
    const shadowed = 'ARG VERSION=1.2.3\nFROM debian AS a\nARG VERSION=9.9.9\nFROM example/upstream:${VERSION}\n';
    expect(checkUpstreamFrom(up, shadowed)).toBeNull();
    // And ENV is stage-scoped too, so it never decides a FROM.
    expect(checkUpstreamFrom(up, 'ARG VERSION=1.2.3\nFROM debian AS a\nENV VERSION=9.9.9\nFROM example/upstream:${VERSION}\n')).toBeNull();
  });

  it('says so when the upstream image is built on without any pin at all', () => {
    const up = { image: 'docker.io/decolua/9router', pinned: '0.5.55' };
    expect(checkUpstreamFrom(up, from('docker.io/decolua/9router'))?.error).toMatch(/no tag/i);
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

  it.each(dirs)('%s: and its FROM agrees with the manifest where it builds on the upstream', (t) => {
    const m = yaml.load(readFileSync(join(templates, t, 'insta.template.yaml'), 'utf8'));
    const df = readFileSync(join(templates, t, 'Dockerfile'), 'utf8');
    expect(checkUpstreamFrom(m?.upstream ?? {}, df)).toBeNull();
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
