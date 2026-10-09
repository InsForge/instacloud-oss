import { describe, it, expect } from 'vitest';
import { checkServiceRuntime, checkTypedFields } from './service-runtime.mjs';

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
