import { useMemo, useState } from 'react'
import { Button, cn, Input } from '@insforge/ui'
import { ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react'
import type { TemplateDetail } from '../api'
import { flattenVariables, isSecretName, placeholderFor, type FlatVariable } from '../lib/templateVars'

function VariableInput({ v, value, missing, onChange }: {
  v: FlatVariable; value: string; missing: boolean; onChange: (val: string) => void
}) {
  const secret = isSecretName(v.name)
  const [show, setShow] = useState(false)
  const readOnly = v.editable === false && v.default !== undefined
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label className="font-mono text-xs font-medium text-foreground">
          {v.name}
          {v.mustFill && <span className="ml-1 text-destructive">*</span>}
        </label>
        {v.generate && <span className="text-[11px] text-muted-foreground">generated if blank</span>}
      </div>
      <div className="relative mt-1">
        <Input
          type={secret && !show ? 'password' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholderFor(v)}
          readOnly={readOnly}
          autoComplete="off"
          className={cn('font-mono', secret && 'pr-9', missing && 'border-destructive')}
        />
        {secret && (
          <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide value' : 'Show value'}
            className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        )}
      </div>
      {v.description && <p className="mt-1 text-xs text-muted-foreground">{v.description}</p>}
      {missing && <p className="mt-1 text-xs text-destructive">Required.</p>}
    </div>
  )
}

/** Variable form for one template (plan 07 H.4): required first, optional collapsed, secret-like
 *  names as password inputs; `missing` marks the names a 400 missing_variables answer named. */
export function TemplateDeployForm({ detail, values, missing, onChange }: {
  detail: TemplateDetail; values: Record<string, string>; missing: string[]; onChange: (name: string, value: string) => void
}) {
  const vars = useMemo(() => flattenVariables(detail), [detail])
  const required = vars.filter((v) => v.required)
  const optional = vars.filter((v) => !v.required)
  const [showOptional, setShowOptional] = useState(missing.some((m) => optional.some((v) => v.name === m)))
  const open = showOptional || missing.some((m) => optional.some((v) => v.name === m))

  if (!vars.length) {
    return <p className="text-sm text-muted-foreground">This template needs no configuration. Deploy it as is.</p>
  }
  return (
    <div className="flex flex-col gap-4">
      {required.length > 0 && (
        <div className="flex flex-col gap-3">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Required</p>
          {required.map((v) => (
            <VariableInput key={v.name} v={v} value={values[v.name] ?? ''} missing={missing.includes(v.name)} onChange={(val) => onChange(v.name, val)} />
          ))}
        </div>
      )}
      {optional.length > 0 && (
        <div className="flex flex-col gap-3">
          <Button variant="ghost" size="sm" className="-ml-2 self-start gap-1 text-xs text-muted-foreground" onClick={() => setShowOptional((s) => !s)}>
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            Optional ({optional.length})
          </Button>
          {open && optional.map((v) => (
            <VariableInput key={v.name} v={v} value={values[v.name] ?? ''} missing={missing.includes(v.name)} onChange={(val) => onChange(v.name, val)} />
          ))}
        </div>
      )}
    </div>
  )
}
