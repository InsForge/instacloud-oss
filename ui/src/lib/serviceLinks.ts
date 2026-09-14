// The canvas's edges, from the daemon's secret tree. The console reads them off
// `GET /projects/:id/secret-bindings` (useServiceLinks + mapServiceLinks), which the daemon does not
// serve yet (a `notYet` stub); the same facts are in `GET /projects/:id/secrets/tree`, where every
// compute service lists the `${{services.x.KEY}}` bindings mapped into it and each binding names its
// source as `<type>/<service name>`. A binding is the only connection a service has to another, so
// this is the whole of "what is wired to what".

import type { SecretTree, Service } from '../api'
import type { ServiceLink } from './serviceGraph'

/**
 * One edge per source → target pair on `branch`, keyed by service id. Several variables bound from
 * one database into one app are one wire, as on the console. A binding whose source or target is not
 * a service row of this branch (deleted, or not yet listed by a poll) draws nothing: an edge with a
 * missing card has nowhere to land.
 */
export function linksFromSecretTree(tree: SecretTree | undefined, branch: string, services: readonly Service[]): ServiceLink[] {
  const env = tree?.branches.find((b) => b.name === branch)
  if (!env) return []
  const idOf = new Map(services.map((s) => [`${s.type}/${s.name}`, s.id]))
  const byPair = new Map<string, ServiceLink>()
  for (const target of env.services) {
    const targetId = idOf.get(`${target.type}/${target.name}`)
    if (!targetId) continue
    for (const binding of target.bindings ?? []) {
      const sourceId = idOf.get(binding.source)
      if (!sourceId || sourceId === targetId) continue
      byPair.set(`${sourceId}>${targetId}`, { sourceId, targetId })
    }
  }
  return [...byPair.values()]
}
