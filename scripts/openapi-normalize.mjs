// Pure transforms shared by scripts/sync-openapi-docs.mjs. Split out so they can be unit tested
// without triggering that script's top-level fetch of the platform's live OpenAPI document.

// The platform declares `openapi: 3.0.3` and writes schemas the 3.0 way: `type: "string",
// nullable: true`. 3.1 dropped `nullable` — it is just an unrecognised annotation there, so the
// bare `type` keyword still rejects `null` and a spec-compliant client will reject a valid null
// response. This walks a document (or any subtree of one) and rewrites every `nullable: true`
// node into the 3.1 form: a `null` member of a `type` array (openapi 3.1 Schema Object,
// https://spec.openapis.org/oas/v3.1.0.html#schema-object), extending `enum` with `null` too so a
// client that validates against the enum still accepts the null the API actually sends. Nodes
// that compose via `allOf`/`oneOf`/`anyOf`/`$ref` instead of a scalar `type` have no `type` to
// widen, so those are wrapped in `anyOf: [<original>, { type: 'null' }]` instead.
export function denullify(node) {
  if (Array.isArray(node)) return node.map(denullify)
  if (!node || typeof node !== 'object') return node

  const out = {}
  for (const [key, value] of Object.entries(node)) out[key] = denullify(value)
  if (out.nullable !== true) { delete out.nullable; return out }
  delete out.nullable

  if (typeof out.type === 'string') {
    out.type = [out.type, 'null']
    if (Array.isArray(out.enum)) out.enum = [...out.enum, null]
    return out
  }
  const { description, ...rest } = out
  const wrapped = { anyOf: [rest, { type: 'null' }] }
  if (description !== undefined) wrapped.description = description
  return wrapped
}

// Header parameters the platform documents as mandatory in prose ("Requires If-Match: ...") and
// enforces with a 400 when absent, but whose generated `required` flag is still false — the
// validation lives in a preValidation hook rather than the route's request schema, so the
// generator that reads the request schema never sees it. Tracked upstream in insta-platform;
// until that lands, force the published contract to match the documented and enforced behaviour.
export const REQUIRED_HEADER_FIXUPS = [
  { method: 'PATCH', path: '/projects/{projectId}/cron-jobs/{id}', name: 'if-match' },
  { method: 'POST', path: '/projects/{projectId}/cron-jobs/{id}/runs', name: 'idempotency-key' },
]

export function applyRequiredHeaderFixups(method, path, op) {
  if (!Array.isArray(op.parameters)) return
  for (const fixup of REQUIRED_HEADER_FIXUPS) {
    if (fixup.method !== method || fixup.path !== path) continue
    const param = op.parameters.find((p) => p.in === 'header' && p.name === fixup.name)
    if (param) param.required = true
  }
}
