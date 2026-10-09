// The platform's name grammar, in one place.
//
// A neutral module on purpose: the engine and the template manifest parser both need these, and
// having the parser import them from the engine forms a cycle (engine -> templates -> manifest ->
// engine). Under that cycle the constants were still undefined when the parser's module body ran,
// so every bundled template silently failed to parse and the catalog came back empty.
//
// Both names become DNS labels — a branch as `<service>-<project>-<branch>.<domain>`, a service as
// the leading label of the same host — and RFC 1123 forbids a label starting or ending with a
// hyphen. They had drifted into several copies, some of which allowed a trailing one and minted
// names whose own hostname is invalid.

// Both are capped at 39 characters. docs/projects/branches.mdx states that limit for branches, and
// the template manifest parser enforced it for codes; an unbounded expression here silently
// removed the parser's cap and let branch create and rename accept names the docs refuse.

/** Branch names: lower-kebab, no leading or trailing hyphen, 1 to 39 characters. */
export const BRANCH_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/

/** Service names: the same shape and the same cap. */
export const SERVICE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/
