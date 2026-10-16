// The canvas's secret-tree read, scoped to the project that made it and aware of governance.
//
// `/secrets/tree` is a governed read (`secrets.read`). Under an `approve` policy every request mints a
// pending approval and can spend a one-shot grant, so a poll that retried a gated read every 30 s would
// fill the approval history and could consume a grant meant for a real action. And the poll hook keeps
// its last data across a project change or a failure, so a tree must never be drawn for a project
// other than the one it was read for.

import type { ApiResult, SecretTree } from '../api'

/** One read's outcome, tagged with the project it was for. `gated`: approval required, or refused. */
export type TreeLoad = { projectId: string; tree: SecretTree | null; gated: boolean }

/** An approval or a refusal is a canvas with no edges and no retry; anything else failing is transient
 *  and thrown, so the poll tries again. */
export async function loadSecretTree(fetchTree: (projectId: string) => Promise<ApiResult<SecretTree>>, projectId: string): Promise<TreeLoad> {
  const r = await fetchTree(projectId)
  if (r.kind === 'ok') return { projectId, tree: r.data, gated: false }
  if (r.kind === 'approval' || r.status === 403) return { projectId, tree: null, gated: true }
  throw Object.assign(new Error(r.error), { status: r.status })
}

/** The tree to draw edges from on `projectId`: only one read for that same project. */
export function treeFor(load: TreeLoad | undefined, projectId: string): SecretTree | undefined {
  return load && load.projectId === projectId && load.tree ? load.tree : undefined
}

/** The projects gated this visit, with `projectId` added. A set that only grows: reads finish out of
 *  order, and a stale completion for another project must never un-gate the one shown now. The same set
 *  when the project is already in it, so marking again does not re-render. */
export function markGated(gated: ReadonlySet<string>, projectId: string): ReadonlySet<string> {
  return gated.has(projectId) ? gated : new Set([...gated, projectId])
}

/** The gated set after a read finishes: a gated read marks the project IT was for (not whichever
 *  project is current when it lands), and any other outcome changes nothing. */
export function afterLoad(gated: ReadonlySet<string>, load: TreeLoad): ReadonlySet<string> {
  return load.gated ? markGated(gated, load.projectId) : gated
}

/** Whether to keep polling: only the canvas draws edges, and a project whose read was gated is not
 *  asked again on this visit. */
export function pollsTree(gated: ReadonlySet<string>, projectId: string, mode: 'canvas' | 'list'): boolean {
  return mode === 'canvas' && !gated.has(projectId)
}
