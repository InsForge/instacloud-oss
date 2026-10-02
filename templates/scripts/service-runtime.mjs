// Shape rules for the two runtime fields, mirrored from the platform parser. Pure so it can be unit-tested.
export function checkServiceRuntime(name, svc) {
  const errors = [];
  const warnings = [];
  if (svc.command !== undefined) {
    if (typeof svc.command !== 'string' || !svc.command.trim()) errors.push(`${name}: command must be a non-empty string`);
    else warnings.push(`${name}: command is cloud-only today, the self-hosted runtime refuses it`);
  }
  if (svc.mountPath !== undefined) {
    if (svc.volume !== true) errors.push(`${name}: mountPath requires volume: true`);
    else if (typeof svc.mountPath !== 'string' || !svc.mountPath.trim().startsWith('/')) errors.push(`${name}: mountPath must be an absolute path`);
    else warnings.push(`${name}: mountPath is cloud-only today, the self-hosted runtime refuses it`);
  }
  return { errors, warnings };
}
