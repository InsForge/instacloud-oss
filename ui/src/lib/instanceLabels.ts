// Container instance names, as logs and metrics report them, reduced to something readable.
//
// There is deliberately no "does this label belong to service X" helper any more. There was one,
// and it could not be made correct: instanceLabel reduces every container ending in `-pg` to
// "postgres", so a postgres service actually NAMED "pg" was indistinguishable from the branch's
// default database and had its own lines dropped. Scoping belongs at the daemon, which both the
// logs and metrics routes support with `?group=`, and which truncates AFTER selecting the
// container rather than before.

/** `io-demo-main-app-worker` -> `worker`; the branch's default database container -> `postgres`.
 *  Everything else (the extra database containers) is returned unchanged. Used only to label a
 *  line or a chart series, never to decide which lines belong to whom. */
export function instanceLabel(instance?: string): string {
  if (!instance) return ''
  if (instance.endsWith('-pg')) return 'postgres'
  const m = /-app-(.+)$/.exec(instance)
  return m ? m[1] : instance
}

/** Display labels for a set of containers, raw instance -> label. The label is only ever a label:
 *  data must be keyed by the raw instance, because `instanceLabel` is not injective — a postgres
 *  service named `pg` gives `io-<ref>-pg-pg`, which ends in `-pg` exactly as the branch's default
 *  database container does, so both reduce to "postgres". Keying a metrics record by the label
 *  therefore dropped one of the two services from the cards and from every chart. Where a label
 *  would be ambiguous within the set, the raw instance is shown instead of a second "postgres". */
export function instanceLabels(instances: readonly string[]): Record<string, string> {
  const count = new Map<string, number>()
  for (const i of instances) {
    const l = instanceLabel(i)
    count.set(l, (count.get(l) ?? 0) + 1)
  }
  // Two passes, because falling back to the raw name is not automatically unambiguous: a group may
  // be NAMED like another container (`insta deploy --group io-demo-main-pg-analytics` mints
  // `io-demo-main-app-io-demo-main-pg-analytics`, whose label is the raw name of the analytics
  // database). Claim the unambiguous labels first, then give anything left a value nothing has
  // taken — the container name, or the container name with its label, which is unique because
  // container names are.
  const out: Record<string, string> = {}
  const used = new Set<string>()
  const deferred: string[] = []
  for (const i of instances) {
    const l = instanceLabel(i)
    if ((count.get(l) ?? 0) > 1) { deferred.push(i); continue }
    out[i] = l
    used.add(l)
  }
  for (const i of deferred) {
    out[i] = used.has(i) ? `${i} (${instanceLabel(i)})` : i
    used.add(out[i])
  }
  return out
}
