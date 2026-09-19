// The `${...}` rule for env.fixed values, in one place because two callers need it and they must
// not drift: lint.mjs reports every violation on the pull request, deploy.mjs refuses to write an
// unresolvable value at deploy time. Both mirror the platform's parser
// (insta-platform src/provisioning/templateManifest.ts), which is the authority.
//
// A fixed value may reference SERVICE ADDRESSES only. The two rejections that are easy to trip:
//   - `${{services.<name>.<KEY>}}` is a platform CREDENTIAL ref and belongs under env.platform.
//     Doubled braces, and it arrives here with the inner one still attached.
//   - a generator ref, even a declared one, is refused: composed into a fixed string it is stored
//     only as the final value, so a retry cannot recover it and would silently rotate the secret.

// Every `${...}` occurrence in a fixed value. Shared safely because both callers use it through
// matchAll (which clones) or replace (which resets lastIndex); .exec/.test on it would not be.
export const FIXED_REF_RE = /\$\{([^}]+)\}/g;

/**
 * Judge one `${...}` body from an env.fixed value.
 * @returns `{ service, prop }` when it resolves, or `{ error }` with a ready-to-print message.
 */
export function checkFixedRef(raw, { at, envName, services = {}, generated = {} }) {
  const ref = String(raw).trim();
  if (ref.startsWith("{")) {
    return { error: `${at}: platform credential refs (\${{services.<name>.<KEY>}}) belong under env.platform, not fixed` };
  }
  const m = /^services\.([a-z0-9-]+)\.([a-zA-Z0-9_]+)$/.exec(ref);
  if (!m) {
    return {
      error: Object.hasOwn(generated, ref)
        ? `${at}: generator refs are not allowed inside fixed values: declare ${envName} under env.generated instead`
        : `${at} references undeclared generator '${ref}'`,
    };
  }
  const [, service, prop] = m;
  // Own-property: the [a-z0-9-] name class still admits words like 'constructor', which truthiness
  // on a plain object would resolve through the prototype chain.
  if (!Object.hasOwn(services, service)) return { error: `${at} references unknown service '${service}'` };
  if (services[service]?.type === "postgres") {
    return { error: `${at}: service '${service}' is a managed postgres: it has no url/host, reference its credentials via env.platform` };
  }
  // A worker is portless (insta-platform#490): nothing is routed to it, so it has no address either.
  if (services[service]?.type === "worker") {
    return { error: `${at}: service '${service}' is a worker: it has no url/host (nothing is routed to it), so no service can reference it` };
  }
  if (prop !== "url" && prop !== "host") {
    return { error: `${at}: '${prop}' is not a resolvable service property (url or host)` };
  }
  return { service, prop };
}
