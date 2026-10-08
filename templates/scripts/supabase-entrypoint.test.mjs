// The Supabase entrypoint renders Envoy configs from deploy-time values, and the gateway logs every
// request. Both broke in review: a username with sed metacharacters rendered the wrong credential,
// and the access log wrote `?apikey=` keys and auth codes to stdout.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase');
const entrypoint = join(dir, 'entrypoint.sh');

// Sourcing the entrypoint defines its functions without dispatching a role.
function sh(script, env = {}) {
  const r = spawnSync('bash', ['-c', `source "$ENTRYPOINT"; ${script}`], {
    env: { PATH: process.env.PATH, INSTA_SUPABASE_ROLE: 'test', ENTRYPOINT: entrypoint, ...env },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('render', () => {
  it('copies every value literally, metacharacters included, and empties unset ones', () => {
    const work = mkdtempSync(join(tmpdir(), 'supabase-render-'));
    writeFileSync(join(work, 'in.yaml'), "a: '${A}'\nb: ${B}\nc: ${UNSET}\n");
    const value = String.raw`R&D|x\y/z`;
    const r = sh('render "$W/in.yaml" "$W/out.yaml" A B UNSET', { W: work, A: value, B: '&' });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(work, 'out.yaml'), 'utf8')).toBe(`a: '${value}'\nb: &\nc: \n`);
  });
});

describe('basic_auth_record', () => {
  const sha1 = (s) => createHash('sha1').update(s).digest('base64');

  it('pairs the username with the SHA-1 of the password, whatever the password holds', () => {
    const password = "p&ss'w|rd:\\";
    const r = sh('basic_auth_record "$U" "$P"', { U: 'ops.team@example-1', P: password });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`ops.team@example-1:{SHA}${sha1(password)}`);
  });

  // Each one would break the user:hash line, the single-quoted YAML scalar, or the line count.
  it.each(['R&D', 'a:b', "o'brien", 'two\nlines', 'a b', ''])('refuses the username %j', (username) => {
    const r = sh('basic_auth_record "$U" pw', { U: username });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/ADMIN_USERNAME/);
  });
});

// The registry keeps manifests as jsonb, which reorders services (a gallery deploy ran auth first
// and it waited forever for a schema another service creates). So no service may rely on another
// having booted: every one that reads DATABASE_URL bootstraps the schema itself.
describe('database bootstrap', () => {
  const manifest = yaml.load(readFileSync(join(dir, 'insta.template.yaml'), 'utf8'));
  const script = readFileSync(entrypoint, 'utf8');
  const readers = Object.entries(manifest.services).filter(([, s]) => s.env?.platform?.DATABASE_URL);

  it('runs in every service that reads DATABASE_URL, before that service starts its process', () => {
    expect(readers.map(([name]) => name).sort()).toEqual(['auth', 'realtime', 'rest', 'storage', 'studio']);
    for (const [name, svc] of readers) {
      expect(svc.image, name).toMatch(/^ghcr\.io\/insforge\/insta-oss\/templates\/supabase:/);
      const role = svc.env.fixed?.INSTA_SUPABASE_ROLE;
      const body = script.match(new RegExp(`^run_${role}\\(\\) \\{\\n([\\s\\S]*?)^\\}`, 'm'))?.[1];
      expect(body, `${name}: run_${role}()`).toBeDefined();
      // The call lines themselves, so a comment or log string naming either word proves nothing.
      const lines = body.split('\n');
      const bootstrapAt = lines.findIndex((l) => /^\s*bootstrap\s*$/.test(l));
      const execAt = lines.findIndex((l) => /^\s*exec\s/.test(l));
      expect(bootstrapAt, `${name}: a bootstrap call`).toBeGreaterThan(-1);
      expect(execAt, `${name}: an exec`).toBeGreaterThan(-1);
      expect(bootstrapAt, name).toBeLessThan(execAt);
    }
  });
});

describe('gateway access log', () => {
  const gateway = readFileSync(join(dir, 'envoy', 'gateway.yaml'), 'utf8');

  it('logs the path and the referer without their query strings', () => {
    // The format holds escaped quotes, so it runs to the end of its line.
    const format = gateway.match(/inline_string: "(%DOWNSTREAM.*)"$/m)[1];
    expect(format).not.toMatch(/%REQ\((X-ENVOY-ORIGINAL-PATH|:PATH|REFERER)/i);
    expect(format).toContain('%REQ_WITHOUT_QUERY(X-ENVOY-ORIGINAL-PATH?:PATH)%');
    expect(format).toContain('%REQ_WITHOUT_QUERY(REFERER)%');
    expect(gateway).toContain('envoy.formatter.req_without_query');
  });
});
