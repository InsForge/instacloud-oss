// The env.fixed `${...}` decision table. n8n is the first manifest in the registry to use a service
// address ref, and before this rule existed `npm run deploy -- n8n` wrote the literal string
// `${services.n8n.url}` into N8N_WEBHOOK_URL: the app booted fine and handed out webhook links
// nobody could call. So the cases below assert the wording as well as the verdict — the message is
// the whole value of catching this on the pull request instead of at deploy time.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { FIXED_REF_RE, checkFixedRef } from './manifest-refs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SERVICES = {
  app: { type: 'web' }, db: { type: 'postgres' }, bg: { type: 'worker' },
  cache: { type: 'redis' }, sql: { type: 'mysql' }, docs: { type: 'mongodb' },
};
const check = (ref, over = {}) =>
  checkFixedRef(ref, { at: 'app: env.fixed.X', envName: 'X', services: SERVICES, generated: { key: 'secret:32' }, ...over });

describe('checkFixedRef: what a fixed value may reference', () => {
  it('resolves a service url ref', () => {
    expect(check('services.app.url')).toEqual({ service: 'app', prop: 'url' });
  });

  it('resolves a host ref', () => {
    expect(check('services.app.host')).toEqual({ service: 'app', prop: 'host' });
  });

  it('tolerates whitespace inside the braces', () => {
    expect(check('  services.app.url  ')).toEqual({ service: 'app', prop: 'url' });
  });

  it('names env.platform for a ${{...}} credential ref', () => {
    // The doubled-brace form arrives with its inner brace attached. Without this branch it would
    // fall through to "undeclared generator '{services.db.DATABASE_URL'", which names nothing real.
    expect(check('{services.db.DATABASE_URL}').error).toContain('belong under env.platform, not fixed');
  });

  it('rejects an unknown service', () => {
    expect(check('services.nope.url').error).toContain("unknown service 'nope'");
  });

  it('rejects a managed postgres, which has no address', () => {
    const { error } = check('services.db.url');
    expect(error).toContain('managed postgres');
    expect(error).toContain('env.platform');
  });

  it('rejects every managed database, naming its type', () => {
    for (const [name, type] of [['db', 'postgres'], ['cache', 'redis'], ['sql', 'mysql'], ['docs', 'mongodb']]) {
      const { error } = check(`services.${name}.url`);
      expect(error).toContain(`service '${name}' is a managed ${type}`);
      expect(error).toContain('env.platform');
    }
  });

  it('rejects a worker, which has no address either', () => {
    // Portless by definition (insta-platform#490): the platform routes nothing to it, so a ref to
    // its url would be a string nobody can call, the n8n failure mode this table exists for.
    const { error } = check('services.bg.host');
    expect(error).toContain("service 'bg' is a worker");
    expect(error).toContain('no url/host');
  });

  it('rejects a property that is not an address', () => {
    expect(check('services.app.port').error).toContain("'port' is not a resolvable service property");
  });

  it('rejects a DECLARED generator, and says where it belongs', () => {
    // Not an oversight: composed into a fixed string the generated value is stored only as the
    // final string, so a retry could not recover it and would silently rotate the secret.
    expect(check('key').error).toContain('declare X under env.generated instead');
  });

  it('rejects an undeclared generator', () => {
    expect(check('nosuch').error).toContain("undeclared generator 'nosuch'");
  });

  it('does not resolve a service name through the prototype chain', () => {
    // 'constructor' passes the [a-z0-9-] name class, and plain truthiness on an object would find
    // it. Object.hasOwn is what makes this an error rather than a crash further down.
    expect(check('services.constructor.url').error).toContain("unknown service 'constructor'");
  });
});

describe('FIXED_REF_RE: finding the refs in a value', () => {
  it('finds a ref embedded in surrounding text', () => {
    const found = [...'ok-${services.app.url}-suffix'.matchAll(FIXED_REF_RE)].map((m) => m[1]);
    expect(found).toEqual(['services.app.url']);
  });

  it('finds every ref in one value', () => {
    const found = [...'${services.app.url}/x/${services.app.host}'.matchAll(FIXED_REF_RE)].map((m) => m[1]);
    expect(found).toEqual(['services.app.url', 'services.app.host']);
  });

  it('is reusable across calls despite being global', () => {
    const once = [...'${services.app.url}'.matchAll(FIXED_REF_RE)].length;
    expect([...'${services.app.url}'.matchAll(FIXED_REF_RE)].length).toBe(once);
  });
});

describe('the shipped n8n manifest', () => {
  it('has every fixed ref resolve', () => {
    const m = yaml.load(readFileSync(join(root, 'n8n/insta.template.yaml'), 'utf8'));
    const refs = [];
    for (const [name, svc] of Object.entries(m.services)) {
      for (const [k, v] of Object.entries(svc.env?.fixed ?? {})) {
        for (const mt of String(v).matchAll(FIXED_REF_RE)) {
          refs.push(checkFixedRef(mt[1], { at: `${name}: env.fixed.${k}`, envName: k, services: m.services, generated: m.generated ?? {} }));
        }
      }
    }
    // Two of them — the webhook and editor base URLs — and both are self-references, which is
    // legal: the platform builds the address map before anything deploys.
    expect(refs).toEqual([{ service: 'n8n', prop: 'url' }, { service: 'n8n', prop: 'url' }]);
  });
});
