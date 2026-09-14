// Which variable names a service's container actually receives, and which scope each one comes
// from. A container receives ONE value per name, so this is a map keyed by name, not a list: the
// daemon overwrites in a fixed order and the Secrets dialog deliberately allows the same name at
// both project and branch scope, so a project `API_KEY` with a branch override is one variable whose
// source is the branch, never two rows with contradictory sources.

import type { SecretTree } from '../api'

export type EffectiveVariable = { name: string; source: string }

/** `<type>/<name>` -> `<name>`. A service id with no slash is already a name. */
function serviceNameOf(serviceId: string): string {
  const i = serviceId.indexOf('/')
  return i === -1 ? serviceId : serviceId.slice(i + 1)
}

type Branch = SecretTree['branches'][number]

/** The order engine.envFor merges in, lowest precedence first:
 *    minted credentials -> project-wide -> this branch's unbound secrets -> bound to THIS group.
 *  A non-compute service shows only what it mints and what is bound to it; a secret bound to
 *  another compute group never reaches this one. */
export function effectiveVariables(
  tree: SecretTree | undefined,
  branch: Branch | undefined,
  service: { type: string; name: string },
): EffectiveVariable[] {
  const effective = new Map<string, string>()
  if (!tree || !branch) return []
  if (service.type === 'compute') {
    for (const s of branch.services) {
      if (s.type === 'compute') continue
      for (const n of s.minted) effective.set(n, s.name)
    }
    for (const n of tree.projectWide) effective.set(n, 'Project')
    for (const n of branch.unbound) effective.set(n, 'Branch')
    const own = branch.services.find((s) => s.type === 'compute' && s.name === service.name)
    // A BINDING is not "this service": the value is read from another service's credential and
    // mapped into this group's env under a different name, and `envFor` applies bindings after
    // everything else. Naming the source is the whole reason someone opens this tab.
    //
    // The bare SERVICE NAME, to match the minted rows above (which use `s.name`). `x.source` is the
    // `<type>/<name>` service id, so labelling with it put two conventions in one column — the same
    // view showed `cache` on a minted row and `redis/cache` on a bound one. `sourceName` is the
    // credential KEY, not a service, so the name is the only service-shaped half available.
    const boundFrom = new Map((own?.bindings ?? []).map((x) => [x.envName, serviceNameOf(x.source)]))
    for (const n of own?.secrets ?? []) effective.set(n, boundFrom.get(n) ?? 'This service')
  } else {
    const own = branch.services.find((s) => s.type === service.type && s.name === service.name)
    for (const n of own?.secrets ?? []) effective.set(n, service.name)
  }
  return Array.from(effective, ([name, source]) => ({ name, source }))
}
