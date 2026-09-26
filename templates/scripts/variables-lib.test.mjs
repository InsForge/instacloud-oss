// The credential contract, replayed over the real registry.
//
// Two things had no coverage and both had already broken once. The resolution order drifted, so
// `npm run deploy` stopped working for every template declaring a `default:` while the platform
// deployed them fine -- no manifest declares one today, but the executor and the platform still
// have to agree about it. And a rename that touches the manifest but not the entrypoint (or two of
// three sibling templates) produces a container that starts and can never be signed into, with no
// error anywhere: ttyd answers 401, and the health check reads 401 as alive.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { valueSource, shellVarsRead } from './variables-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NON_TEMPLATE = new Set(['scripts', 'node_modules']);
const templates = readdirSync(root)
  .filter((d) => !NON_TEMPLATE.has(d) && statSync(join(root, d)).isDirectory())
  .map((dir) => ({ dir, manifest: yaml.load(readFileSync(join(root, dir, 'insta.template.yaml'), 'utf8')) }));

// Set by the Dockerfile, not by the manifest, so an entrypoint may read them freely.
const IMAGE_PROVIDED = new Set(['HOME', 'PATH', 'PWD', 'SHELL', 'TERM', 'USER', 'LANG']);

describe('valueSource: the platform resolution order', () => {
  it('prefers a supplied value over both generator and default', () => {
    expect(valueSource({ generate: 'secret:16', default: 'd' }, 'mine')).toBe('provided');
  });

  it('treats an empty string as absent', () => {
    // A blank form field must fall through rather than write "" into the environment.
    expect(valueSource({ default: 'd' }, '')).toBe('default');
  });

  it('prefers a generator over a default', () => {
    // The reason a spec should never carry both: the default is then dead text no one can reach.
    expect(valueSource({ generate: 'secret:16', default: 'd' }, undefined)).toBe('generate');
  });

  it('falls back to the default', () => {
    expect(valueSource({ default: 'admin' }, undefined)).toBe('default');
  });

  it('reports nothing when a variable declares neither', () => {
    expect(valueSource({ description: 'an API key' }, undefined)).toBeNull();
  });
});

/** Required variables a bare `npm run deploy -- <code>` would still have to be given. */
function demands(manifest) {
  const out = [];
  for (const svc of Object.values(manifest.services ?? {})) {
    for (const [k, spec] of Object.entries(svc.env?.required ?? {})) {
      if (valueSource(spec, undefined) === null) out.push(k);
    }
  }
  return out.sort();
}

describe('the credentialed templates ship no credential of their own', () => {
  // What this locks down is a security property, not a convenience one. Each of these publishes a
  // root shell, an agent that runs one, an agent's control panel, or an inference endpoint whose
  // cheapest request is a few hundred milliseconds of CPU, all over HTTP basic auth. So a
  // `default:` here would be one password shared by every deployment in the world, and a
  // `generate:` would be a password the operator never sees. The manifests declare both variables
  // required with neither, which is what makes the console render two empty fields it will not let
  // you submit blank.
  it.each(['claude-code', 'codex', 'dsh', 'hermes', 'pi'])('%s makes the operator supply both', (dir) => {
    const svc = Object.values(templates.find((t) => t.dir === dir).manifest.services)[0];
    for (const k of ['ADMIN_USERNAME', 'ADMIN_PASSWORD']) {
      // null = nothing to fall back on. The platform answers MissingTemplateVariables; the console
      // blocks submit. Re-adding a default or a generator flips this and fails here.
      expect(valueSource(svc.env.required[k], undefined), `${k} must have no fallback`).toBeNull();
      expect(valueSource(svc.env.required[k], 'typed'), `${k} must accept a value`).toBe('provided');
    }
  });

  // hermes joined this list in 2.2.0, when its OpenRouter key and Telegram values moved to
  // `optional`: the admin pair is now the whole of what it demands, and this is the regression
  // guard that keeps the keyless, channel-less deploy contract from drifting.
  it.each(['claude-code', 'codex', 'dsh', 'hermes', 'pi'])('%s demands those two and nothing else', (dir) => {
    // Scoped both ways on purpose: a fourth required variable would be a new thing to type on the
    // deploy form, and dropping one would mean a credential came back from somewhere.
    expect(demands(templates.find((t) => t.dir === dir).manifest))
      .toEqual(['ADMIN_PASSWORD', 'ADMIN_USERNAME']);
  });

  it('laya makes the operator supply exactly one API key', () => {
    // laya dropped the ADMIN pair in 0.2.0: it is an API consumed programmatically (Bearer key, or
    // basic auth with the fixed username `api`), unlike the browser terminals above where a
    // login prompt fits. The same security property holds: required, no default, no generator.
    const svc = Object.values(templates.find((t) => t.dir === 'laya').manifest.services)[0];
    expect(demands(templates.find((t) => t.dir === 'laya').manifest)).toEqual(['API_KEY']);
    expect(valueSource(svc.env.required.API_KEY, undefined), 'API_KEY must have no fallback').toBeNull();
    expect(valueSource(svc.env.required.API_KEY, 'typed'), 'API_KEY must accept a value').toBe('provided');
  });

  it('no template lets a required variable fall back to anything', () => {
    // Stated once over the whole registry, because the rule is not really about those five: a
    // required variable is one the platform cannot supply, and hermes shipped that way until
    // 2.0.0. Its `generate: secret:16` minted a dashboard password into a
    // write-only store (a template variable is stored `minted = false`, and only minted rows come
    // back from GET /credentials), so an operator who did not copy it off the form lost the
    // dashboard with no error anywhere. A value nobody needs to read belongs under `env.generated`
    // instead, the way n8n declares its encryption key.
    const withFallback = templates.flatMap((t) =>
      Object.values(t.manifest.services ?? {}).flatMap((svc) =>
        Object.entries(svc.env?.required ?? {})
          .filter(([, spec]) => valueSource(spec, undefined) !== null)
          .map(([k]) => `${t.dir}:${k}`)));
    expect(withFallback).toEqual([]);
  });
});

describe('every variable an entrypoint reads is declared by its manifest', () => {
  const withEntrypoint = templates.filter((t) => existsSync(join(root, t.dir, 'entrypoint.sh')));

  it('covers the templates that ship one', () => {
    // Guards the guard: if entrypoints move or get renamed, the cases below would silently
    // become an empty suite that passes forever. 9router and openclaw ship one while requiring no
    // credential at all, which is the case the per-template check below has to stay honest about.
    expect(withEntrypoint.map((t) => t.dir).sort()).toEqual(['9router', 'claude-code', 'codex', 'dsh', 'hermes', 'laya', 'lev', 'openclaw', 'pi', 'whisper-turbo']);
  });

  it.each(withEntrypoint)('$dir', ({ dir, manifest }) => {
    const declared = new Set();
    for (const svc of Object.values(manifest.services ?? {})) {
      for (const group of ['fixed', 'generated', 'platform', 'required', 'optional']) {
        for (const k of Object.keys(svc.env?.[group] ?? {})) declared.add(k);
      }
    }
    const read = shellVarsRead(readFileSync(join(root, dir, 'entrypoint.sh'), 'utf8'));
    const undeclared = read.filter((n) => !declared.has(n) && !IMAGE_PROVIDED.has(n));
    expect(undeclared).toEqual([]);
  });

  it('actually sees the credential variables, not an empty read set', () => {
    // Without this the case above passes just as happily on a script that reads nothing at all.
    const read = shellVarsRead(readFileSync(join(root, 'pi/entrypoint.sh'), 'utf8'));
    expect(read).toEqual(expect.arrayContaining(['ADMIN_USERNAME', 'ADMIN_PASSWORD']));
  });
});

describe('shellVarsRead', () => {
  it('ignores names the script assigns itself', () => {
    expect(shellVarsRead('CRED="${ADMIN_USERNAME:-admin}"\necho "$CRED"')).toEqual(['ADMIN_USERNAME']);
  });

  it('reads every parameter-expansion form', () => {
    const found = shellVarsRead('echo "${A} ${B:-x} ${C:?y} $D"');
    expect(found).toEqual(['A', 'B', 'C', 'D']);
  });
});
