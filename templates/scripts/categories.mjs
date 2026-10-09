// What in this repo disagrees with the platform's template categories (GET /template-categories).
//
// The platform owns the list. Two things here depend on it and cannot read it at the moment they
// are used: a manifest's `meta.category`, which the gallery labels from the list, and the snapshot
// the self-hosted UI ships (ui/src/lib/template-categories.json), which runs with no platform at
// all. Pure, so the test needs no network: check-categories.mjs does the fetching.

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The `{ categories: [{ slug, label }] }` envelope, or null for anything else. Strict because
 * `--write` persists what this returns: an empty list, a blank label or a repeated slug would land
 * in the UI snapshot as a broken picker.
 */
export function readCategories(body) {
  const list = body?.categories;
  if (!Array.isArray(list) || list.length === 0) return null;
  const ok = list.every((c) => typeof c?.slug === "string" && SLUG_RE.test(c.slug) && typeof c?.label === "string" && c.label.trim() !== "");
  if (!ok || new Set(list.map((c) => c.slug)).size !== list.length) return null;
  return list.map(({ slug, label }) => ({ slug, label }));
}

/**
 * One line per problem: each manifest whose category the platform does not list, then the
 * snapshot if it differs from the list at all, order and labels included.
 */
export function categoryProblems(listed, manifests, snapshot) {
  const slugs = new Set(listed.map((c) => c.slug));
  const problems = manifests
    .filter((m) => m.category && !slugs.has(m.category))
    .map((m) => `${m.dir}: meta.category '${m.category}' is not one of the platform's categories`);
  if (JSON.stringify(readCategories(snapshot)) !== JSON.stringify(listed)) {
    problems.push("ui/src/lib/template-categories.json differs from the platform: npm run check-categories -- --write");
  }
  return problems;
}
