import { describe, it, expect } from 'vitest';
import { checkServiceRuntime, checkServiceSource, checkServiceWays, checkTypedFields } from './service-runtime.mjs';

describe('checkServiceRuntime', () => {
  it('passes a service without the fields', () => {
    expect(checkServiceRuntime('app', { type: 'web' })).toEqual({ errors: [], warnings: [] });
  });
  it('refuses an empty command', () => {
    expect(checkServiceRuntime('app', { type: 'web', command: ' ' }).errors).toEqual(['app: command must be a non-empty string']);
  });
  it('refuses mountPath without volume: true', () => {
    expect(checkServiceRuntime('app', { type: 'web', mountPath: '/a' }).errors).toEqual(['app: mountPath requires volume: true']);
  });
  it('refuses a relative mountPath', () => {
    expect(checkServiceRuntime('app', { type: 'web', volume: true, mountPath: 'a' }).errors).toEqual(['app: mountPath must be an absolute path']);
  });
  it('trims mountPath before the absolute check, like the parser', () => {
    expect(checkServiceRuntime('app', { type: 'web', volume: true, mountPath: ' /app/storage ' }).errors).toEqual([]);
  });
  it('warns that either field is cloud-only', () => {
    const r = checkServiceRuntime('app', { type: 'web', command: 'run', volume: true, mountPath: '/a' });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual(['app: command is cloud-only today, the self-hosted runtime refuses it', 'app: mountPath is cloud-only today, the self-hosted runtime refuses it']);
  });
});

describe('checkTypedFields', () => {
  it('passes a service without either field', () => {
    expect(checkTypedFields('db', { type: 'postgres' })).toEqual({ errors: [], warnings: [] });
    expect(checkTypedFields('files', { type: 'storage' })).toEqual({ errors: [], warnings: [] });
  });
  it('takes an integer pgVersion on postgres and warns it is cloud-only unless it is the local major', () => {
    const r = checkTypedFields('db', { type: 'postgres', pgVersion: 17 });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual(['db: pgVersion is cloud-only today unless it equals the major the self-hosted runtime runs (PG_VERSION in src/engine.ts)']);
  });
  it('refuses a pgVersion that is not an integer', () => {
    for (const pgVersion of ['17', 17.5, true, null]) {
      expect(checkTypedFields('db', { type: 'postgres', pgVersion }).errors, String(pgVersion)).toEqual(['db: pgVersion must be an integer, a Postgres major version']);
    }
  });
  it('refuses pgVersion on any other type', () => {
    for (const type of ['web', 'storage', 'redis']) {
      expect(checkTypedFields('x', { type, pgVersion: 17 }).errors, type).toEqual(['x: pgVersion is only valid on a postgres service']);
    }
  });
  it('takes a boolean public on storage', () => {
    for (const value of [true, false]) {
      expect(checkTypedFields('files', { type: 'storage', public: value })).toEqual({ errors: [], warnings: [] });
    }
  });
  it('refuses a public that is not a boolean', () => {
    for (const value of ['yes', 1, null]) {
      expect(checkTypedFields('files', { type: 'storage', public: value }).errors, String(value)).toEqual(['files: public must be a boolean']);
    }
  });
  it('refuses public on any other type', () => {
    for (const type of ['web', 'postgres']) {
      expect(checkTypedFields('x', { type, public: true }).errors, type).toEqual(['x: public is only valid on a storage service']);
    }
  });
});

describe('checkServiceSource', () => {
  it('passes a service without source', () => {
    expect(checkServiceSource('app', { type: 'web', image: 'i:1' })).toEqual({ errors: [], warnings: [] });
  });
  it('takes owner and repo with the optional fields, and warns that it is cloud-only', () => {
    const source = { owner: 'acme', repo: 'shop', branch: 'main', rootDir: 'apps/web', buildCommand: 'pnpm build' };
    expect(checkServiceSource('app', { type: 'web', source })).toEqual({ errors: [], warnings: ['app: source is cloud-only today, the self-hosted runtime refuses it'] });
  });
  it('refuses a source that is not a map', () => {
    for (const source of ['acme/shop', null, ['acme', 'shop']]) {
      expect(checkServiceSource('app', { type: 'web', source }).errors, String(source)).toEqual(['app: source must be a map with owner and repo']);
    }
  });
  it('refuses a key the platform does not take, and a missing owner or repo', () => {
    expect(checkServiceSource('app', { type: 'web', source: { repo: 'shop', commit: 'abc' } }).errors)
      .toEqual(['app: source.commit is not a source field', 'app: source.owner must be a non-empty string']);
    expect(checkServiceSource('app', { type: 'web', source: { owner: 'acme', repo: ' ' } }).errors).toEqual(['app: source.repo must be a non-empty string']);
  });
});

describe('checkServiceWays', () => {
  const source = { owner: 'acme', repo: 'shop' };
  const imageBuild = 'app: image and build are mutually exclusive: drop build:, keep image:';
  const sourceWith = (other) => `app: source and ${other} are mutually exclusive: keep one`;
  it('takes exactly one of image, build and source', () => {
    for (const svc of [{ image: 'i:1' }, { build: 'Dockerfile' }, { source }]) {
      expect(checkServiceWays('app', svc), JSON.stringify(svc)).toEqual({ errors: [] });
    }
  });
  it('asks for one when none is given, and an empty or null image or build with nothing else is none', () => {
    for (const svc of [{}, { image: '' }, { build: '' }, { image: null }, { image: '', build: '' }]) {
      expect(checkServiceWays('app', svc).errors, JSON.stringify(svc)).toEqual(['app: needs image, build or source']);
    }
  });
  it('refuses image and build together with the existing sentence', () => {
    expect(checkServiceWays('app', { image: 'i:1', build: 'Dockerfile' }).errors).toEqual([imageBuild]);
  });
  it('refuses source beside image or build', () => {
    expect(checkServiceWays('app', { image: 'i:1', source }).errors).toEqual([sourceWith('image')]);
    expect(checkServiceWays('app', { build: 'Dockerfile', source }).errors).toEqual([sourceWith('build')]);
  });
  it('counts a key by presence, so an empty or null image or build beside another way is still refused', () => {
    for (const extra of [{ image: '' }, { image: null }]) {
      expect(checkServiceWays('app', { source, ...extra }).errors, JSON.stringify(extra)).toEqual([sourceWith('image')]);
    }
    for (const extra of [{ build: '' }, { build: null }]) {
      expect(checkServiceWays('app', { source, ...extra }).errors, JSON.stringify(extra)).toEqual([sourceWith('build')]);
    }
    expect(checkServiceWays('app', { image: 'i:1', build: '' }).errors).toEqual([imageBuild]);
  });
  it('reads a null source as present, never as absent', () => {
    expect(checkServiceWays('app', { source: null })).toEqual({ errors: [] });
    expect(checkServiceWays('app', { image: 'i:1', source: null }).errors).toEqual([sourceWith('image')]);
  });
});
