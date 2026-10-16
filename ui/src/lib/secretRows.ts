// The rows behind the Secrets page and a service's Variables tab (insta-frontend lib/api/secrets.ts
// `buildGroupedSecrets`, secrets/secrets-view.tsx, secrets/service-variables-tab.tsx), built from the daemon's
// names-only secret tree. Pure so the root vitest covers it.
//
// Self-host divergence: rows carry names, never values. The dashboard does not read a secret value; `insta secrets
// --print` does.

import type { SecretTree } from '../api'

export type SecretScope = 'env' | 'project'
/** `kind` decides both the badge and whether Edit/Delete are offered. 'binding' is platform-owned like 'managed',
 *  but for a different reason and from a different place, so it says so. */
export type SecretKind = 'user' | 'managed' | 'binding'
export type SecretRow = {
  name: string
  kind: SecretKind
  scope: SecretScope
  /** `<type>/<name>` of the service the secret is bound to, for a service-bound row. */
  service?: string
  /** `<source>.<name>` a binding reads from. */
  from?: string
  /** A binding that shadows a user secret of the same name, which the binding hides. */
  shadowed?: boolean
}
export type SecretGroup = { key: string; type: string; name: string; rows: SecretRow[] }
export type SortOrder = 'az' | 'za'
export const SORT_LABELS: Record<SortOrder, string> = { az: 'Name (A–Z)', za: 'Name (Z–A)' }

/** The branch's secrets, one group per service (what it mints, what is bound to it, and the user secrets bound to
 *  it), plus the shared rows: project-wide secrets and this branch's unbound ones. */
export function groupSecrets(tree: SecretTree, branch: string): { services: SecretGroup[]; shared: SecretRow[] } {
  const env = tree.branches.find((b) => b.name === branch)
  const services: SecretGroup[] = (env?.services ?? []).map((s) => {
    const key = `${s.type}/${s.name}`
    // The daemon says which names it minted (secrets/tree `minted`), so ask it rather than guess from the name.
    // Guessing matched only the `*_URL` forms, so the rest of a managed bundle (REDIS_HOST_CACHE and friends) was
    // badged User and offered Edit and Delete: the daemon refuses to edit a reserved name, and the delete removed no
    // user row because there is none.
    const minted = new Set(s.minted)
    // A binding is platform-owned too, and editing or deleting one silently does nothing: Delete calls
    // unsetUserSecret, which never touches a binding, and Edit writes a user row that `envFor` overrides because
    // bindings are applied last. Both reported success.
    const bindings = new Map(s.bindings.map((x) => [x.envName, x]))
    return {
      key, type: s.type, name: s.name,
      rows: s.secrets.map((n) => {
        const bound = bindings.get(n)
        return {
          name: n,
          kind: (minted.has(n) ? 'managed' : bound ? 'binding' : 'user') as SecretKind,
          scope: 'env' as const,
          service: key,
          ...(bound ? { from: `${bound.source}.${bound.sourceName}`, shadowed: bound.shadowsUserSecret } : {}),
        }
      }),
    }
  })
  const shared: SecretRow[] = [
    ...tree.projectWide.map((n) => ({ name: n, kind: 'user' as const, scope: 'project' as const })),
    ...(env?.unbound ?? []).map((n) => ({ name: n, kind: 'user' as const, scope: 'env' as const })),
  ]
  return { services, shared }
}

/** One service's rows, as its Variables tab shows them: what it mints, what is bound to it, and the user secrets
 *  bound to it. Shared secrets stay on the Secrets page's Shared tab, as on the console. */
export function serviceSecretRows(tree: SecretTree | undefined, branch: string, service: { type: string; name: string }): SecretRow[] {
  if (!tree) return []
  const key = `${service.type}/${service.name}`
  return groupSecrets(tree, branch).services.find((g) => g.key === key)?.rows ?? []
}

/** Names containing `query` (case-insensitive; the caller lower-cases and trims it), sorted by name. */
export function filterAndSort(rows: readonly SecretRow[], query: string, sort: SortOrder): SecretRow[] {
  return rows
    .filter((r) => !query || r.name.toLowerCase().includes(query))
    .sort((a, b) => (sort === 'az' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)))
}
