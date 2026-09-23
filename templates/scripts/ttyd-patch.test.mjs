// ttyd logs its credential on every start; each image that ships it must patch that out and verify it.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (code, file) => (existsSync(join(root, code, file)) ? readFileSync(join(root, code, file), 'utf8') : '');
// Keyed on ttyd itself, not on how the binary is fetched, so a new source cannot slip past.
const ttyd = readdirSync(root)
  .filter((code) => /\bttyd\b/.test(read(code, 'Dockerfile') + read(code, 'entrypoint.sh')))
  .map((code) => ({ code, text: read(code, 'Dockerfile') }));

const UPSTREAM_CHECK = 'echo "${ttyd_sha}  /usr/local/bin/ttyd" | sha256sum -c -';
const PATCH = "sed -i 's/  credential: %s/  credential: **/' /usr/local/bin/ttyd";
const PATCHED_CHECK = 'echo "${patched_sha}  /usr/local/bin/ttyd" | sha256sum -c -';
const pins = (text) => [...text.matchAll(/^ARG (TTYD_\w*SHA256_\w+)=(\w+)$/gm)].map((m) => `${m[1]}=${m[2]}`);

describe('ttyd images keep the credential out of the startup log', () => {
  it('covers every ttyd template', () => {
    expect(ttyd.map((t) => t.code)).toEqual(expect.arrayContaining(['claude-code', 'codex', 'pi']));
  });

  it.each(ttyd)('$code checks the release, patches it, then checks the patched binary', ({ text }) => {
    const upstream = text.indexOf(UPSTREAM_CHECK);
    const patch = text.indexOf(PATCH);
    expect(upstream).toBeGreaterThan(-1);
    expect(patch).toBeGreaterThan(upstream);
    expect(text.indexOf(PATCHED_CHECK, patch)).toBeGreaterThan(patch);
  });

  it('every ttyd image pins the same release and patched checksums', () => {
    const [first, ...rest] = ttyd.map((t) => pins(t.text));
    expect(first).toHaveLength(4);
    for (const p of rest) expect(p).toEqual(first);
  });
});
