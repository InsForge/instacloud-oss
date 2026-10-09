// Template deploy-form rules, mirroring the platform's manifest resolution: a variable declared
// twice is one input (required OR-ed), a generator or a default means the operator may leave it
// blank, and a blank value is "absent" on the wire.

/** The cloud's TemplateVariable schema (openapi TemplateVariable); `key` appears only in the
 *  400 missing_variables envelope. */
export interface TemplateVariable {
  name: string
  description?: string
  required?: boolean
  default?: string
  generate?: string | null
  editable?: boolean
  key?: string
}

export interface FlatVariable {
  name: string
  description?: string
  required: boolean
  default?: string
  generate?: string | null
  editable?: boolean
  /** The operator must type a value: required, no generator, no default. */
  mustFill: boolean
}

export interface VariableGroups { required?: TemplateVariable[]; optional?: TemplateVariable[] }

export function mustFill(v: { required?: boolean; generate?: string | null; default?: string }): boolean {
  const hasGenerator = v.generate != null && v.generate !== ''
  return !!v.required && !hasGenerator && v.default === undefined
}

/** Required group first, then optional, each in manifest order; duplicates collapse onto the
 *  first occurrence with `required` OR-ed across both (the CLI's template-manifest rule). */
export function flattenVariables(detail: { variables?: VariableGroups | null }): FlatVariable[] {
  const byName = new Map<string, FlatVariable>()
  const order: string[] = []
  const add = (v: TemplateVariable, groupRequired: boolean) => {
    if (!v?.name) return
    const required = groupRequired || v.required === true
    const prev = byName.get(v.name)
    if (prev) {
      if (required && !prev.required) {
        prev.required = true
        prev.mustFill = mustFill(prev)
      }
      return
    }
    const flat: FlatVariable = {
      name: v.name,
      description: v.description,
      required,
      default: v.default,
      generate: v.generate,
      editable: v.editable,
      mustFill: false,
    }
    flat.mustFill = mustFill(flat)
    byName.set(v.name, flat)
    order.push(v.name)
  }
  for (const v of detail.variables?.required ?? []) add(v, true)
  for (const v of detail.variables?.optional ?? []) add(v, false)
  const all = order.map((n) => byName.get(n)!)
  return [...all.filter((v) => v.required), ...all.filter((v) => !v.required)]
}

/** Names that look like credentials get a password input with a reveal toggle. */
export function isSecretName(name: string): boolean {
  return /(PASSWORD|SECRET|TOKEN|_KEY$|API_KEY|PRIVATE)/.test(name.toUpperCase())
}

export function placeholderFor(v: FlatVariable): string {
  if (v.generate != null && v.generate !== '') return 'generated on deploy'
  if (v.default !== undefined) return `default: ${v.default}`
  return ''
}

/** Every must-fill variable has a non-blank value. */
export function canSubmit(vars: FlatVariable[], values: Record<string, string>): boolean {
  return vars.every((v) => !v.mustFill || (values[v.name] ?? '').trim() !== '')
}

/** Drop blank entries: the platform treats a blank as absent (generator or default applies). */
export function payloadVariables(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'string' && v.trim() !== '') out[k] = v
  }
  return out
}

/** Names to mark after a 400 `missing_variables`: each entry's `name`, else its `key`. */
export function applyMissing(body: unknown): string[] {
  const missing = (body as { missing?: unknown } | null)?.missing
  if (!Array.isArray(missing)) return []
  const names: string[] = []
  for (const m of missing) {
    if (typeof m === 'string') { if (m && !names.includes(m)) names.push(m); continue }
    const entry = m as { name?: unknown; key?: unknown } | null
    const n = typeof entry?.name === 'string' && entry.name ? entry.name
      : typeof entry?.key === 'string' && entry.key ? entry.key : null
    if (n && !names.includes(n)) names.push(n)
  }
  return names
}
