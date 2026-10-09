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

// pgVersion belongs to postgres and public to storage, the per-type rule add() applies on the platform.
export function checkTypedFields(name, svc) {
  const errors = [];
  const warnings = [];
  if (svc.pgVersion !== undefined) {
    if (svc.type !== 'postgres') errors.push(`${name}: pgVersion is only valid on a postgres service`);
    else if (!Number.isInteger(svc.pgVersion)) errors.push(`${name}: pgVersion must be an integer, a Postgres major version`);
    else warnings.push(`${name}: pgVersion is cloud-only today unless it equals the major the self-hosted runtime runs (PG_VERSION in src/engine.ts)`);
  }
  if (svc.public !== undefined) {
    if (svc.type !== 'storage') errors.push(`${name}: public is only valid on a storage service`);
    else if (typeof svc.public !== 'boolean') errors.push(`${name}: public must be a boolean`);
  }
  return { errors, warnings };
}

// source: a GitHub repo the cloud builds at deploy. The shape here, the field grammar at publish.
const SOURCE_FIELDS = ['owner', 'repo', 'branch', 'rootDir', 'buildCommand'];
export function checkServiceSource(name, svc) {
  const errors = [];
  const warnings = [];
  if (svc.source === undefined) return { errors, warnings };
  const s = svc.source;
  if (s === null || typeof s !== 'object' || Array.isArray(s)) {
    errors.push(`${name}: source must be a map with owner and repo`);
    return { errors, warnings };
  }
  for (const key of Object.keys(s)) if (!SOURCE_FIELDS.includes(key)) errors.push(`${name}: source.${key} is not a source field`);
  for (const key of ['owner', 'repo']) if (typeof s[key] !== 'string' || !s[key].trim()) errors.push(`${name}: source.${key} must be a non-empty string`);
  if (!errors.length) warnings.push(`${name}: source is cloud-only today, the self-hosted runtime refuses it`);
  return { errors, warnings };
}
