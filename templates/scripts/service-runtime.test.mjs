import { describe, it, expect } from 'vitest';
import { checkServiceRuntime } from './service-runtime.mjs';

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
