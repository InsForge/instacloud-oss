// The Service page's services read, scoped to the project and branch that made it (the same pattern as
// secretTreeLoad.ts). Pure so the root vitest covers it.
//
// The poll hook keeps its last data across a change of dependencies and across a failed request. Deriving the page
// from that untagged data meant a list read for the previous branch decided what the new one showed: moving from an
// empty branch to one with services kept the connect-agent panel (and an empty canvas) up until the new read
// answered, and indefinitely if it failed. A read now counts only for the scope it was made for.

import type { Service } from '../api'

/** One read's result, tagged with the project and branch it was for. */
export type ServicesLoad = { projectId: string; branch: string; services: Service[] }

/** The services to draw for `projectId`/`branch`: only a read for that same scope, else undefined (not loaded). */
export function servicesFor(load: ServicesLoad | undefined, projectId: string, branch: string): Service[] | undefined {
  return load && load.projectId === projectId && load.branch === branch ? load.services : undefined
}
