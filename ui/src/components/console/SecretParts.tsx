// The console's secret table, source badge and dialog (insta-frontend secrets/secrets-view.tsx `SourceBadge`,
// secrets/secret-dialog.tsx `SecretDialog` and `VariableDialog`, secrets/secret-actions-menu.tsx), shared by the
// Secrets page and a service's Variables tab.
//
// Self-host divergences: values stay hidden (the dashboard never reads a secret value; `insta secrets --print`
// does), and a save or delete applies immediately instead of staging for Deploy.

import { useState, type FormEvent } from 'react'
import {
  Button, cn, Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle, DropdownMenu,
  DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Input, Select, SelectContent, SelectItem, SelectTrigger,
  SelectValue,
} from '@insforge/ui'
import { EllipsisVertical } from 'lucide-react'
import { api } from '../../api'
import type { PendingApproval } from '../ApprovalPrompt'
import type { SecretGroup, SecretKind, SecretRow, SecretScope } from '../../lib/secretRows'
import { newSecretNameError } from '../../lib/secretNames'

const UNBOUND = 'none'

const BADGE: Record<SecretKind, { label: string; className: string }> = {
  user: { label: 'User', className: 'bg-success/10 text-success' },
  managed: { label: 'Managed', className: 'bg-alpha-8 text-muted-foreground' },
  binding: { label: 'Binding', className: 'bg-alpha-8 text-muted-foreground' },
}

export function SourceBadge({ kind, from }: { kind: SecretKind; from?: string }) {
  return (
    <span className={cn('rounded-md px-1.5 py-0.5 text-xs font-medium', BADGE[kind].className)}
      title={from ? `Bound from ${from}` : undefined}>
      {BADGE[kind].label}
    </span>
  )
}

function Th({ children, className }: { children?: string; className?: string }) {
  return <th className={cn('px-4 py-3 text-left text-[13px] font-normal text-muted-foreground', className)}>{children}</th>
}

/** A Name / Source / Value table. `noun` is the surface's word: the Secrets page says Secret, a Variables tab Variable. */
export function SecretsTable({ rows, emptyMessage, noun = 'Secret', onEdit, onDelete }: {
  rows: SecretRow[]; emptyMessage: string; noun?: 'Secret' | 'Variable'
  onEdit: (row: SecretRow) => void; onDelete: (row: SecretRow) => void
}) {
  return (
    <table className="w-full table-fixed">
      <thead>
        <tr className="border-b border-border bg-alpha-4">
          <Th>Name</Th>
          <Th className="w-28">Source</Th>
          <Th>Value</Th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td colSpan={3} className="px-4 py-6 text-center text-sm text-muted-foreground">{emptyMessage}</td></tr>
        ) : rows.map((row) => (
          <tr key={`${row.scope}:${row.service ?? ''}:${row.name}`} className="group/row border-b border-border transition-colors last:border-b-0 hover:bg-alpha-4">
            <td className="truncate px-4 py-2 font-mono text-[13px]">{row.name}</td>
            <td className="px-4 py-2"><SourceBadge kind={row.kind} from={row.from} /></td>
            <td className="py-2 pl-4">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] tracking-widest text-muted-foreground select-none"
                  title="Values are never shown here. Read one with insta secrets --print.">••••••</span>
                <div className="w-8 shrink-0">
                  {(row.kind === 'user' || row.shadowed) && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.name}`} className="text-muted-foreground hover:text-primary">
                          <EllipsisVertical className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {/* No Edit on a shadowed binding: the binding is applied last, so an edit would write a user
                            row the container still never sees. Delete is the one action that does something: it
                            removes the dead row underneath. */}
                        {row.kind === 'user' && <DropdownMenuItem onSelect={() => onEdit(row)}>Edit {noun}</DropdownMenuItem>}
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onDelete(row)}>
                          {row.shadowed ? `Delete Shadowed ${noun}` : `Delete ${noun}`}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The label-left secret dialog. `fixedService` is the console's VariableDialog: the variable is bound to that
 *  service in this branch, so the Scope and Service pickers are not shown. */
export function SecretDialog({ projectId, branch, services, editing, noun = 'Secret', fixedService, onClose, onDone, onApproval }: {
  projectId: string; branch: string; services: SecretGroup[]; editing: SecretRow | null
  noun?: 'Secret' | 'Variable'; fixedService?: SecretGroup
  onClose: () => void; onDone: () => void; onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const [name, setName] = useState(editing?.name ?? '')
  const [value, setValue] = useState('')
  const [scope, setScope] = useState<SecretScope>(fixedService ? 'env' : editing?.scope ?? 'env')
  const [service, setService] = useState(fixedService?.key ?? editing?.service ?? UNBOUND)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (nextName: string) => {
    setBusy(true)
    const bound = scope === 'env' && service !== UNBOUND ? service : undefined
    const r = await api.setSecret(projectId, nextName, value, scope === 'env' ? branch : undefined, bound)
    setBusy(false)
    if (r.kind === 'error') return setError(r.error)
    // Close on success only: closing first sent a failed approval-retry's error to a dialog that was no longer mounted.
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void save(nextName) } })
    onClose()
    onDone()
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    const nextName = name.trim()
    // A NEW name must be a usable environment variable name (lib/secretNames.ts): the dialog used to take anything but
    // an empty name or `=`, so "bad name" was stored and then never reached a container as a variable. An existing name
    // is not re-checked, since the field is locked while editing; a secret created with the CLI stays editable.
    if (!nextName) return setError('A name is required.')
    if (!editing) {
      const nameError = newSecretNameError(nextName)
      if (nameError) return setError(nameError)
    }
    // The other door onto the same trap the row actions close: a name a BINDING already maps into the selected service
    // can be written as a user secret, and `envFor` applies bindings last, so the container keeps the bound value and
    // the row you just created does nothing. The daemon allows it (bindings bypass `isReservedSecret` by design), so
    // say so here rather than write a secret that silently loses.
    const target = scope === 'env' && service !== UNBOUND ? (fixedService?.key === service ? fixedService : services.find((g) => g.key === service)) : undefined
    const clash = target?.rows.find((r) => r.kind === 'binding' && r.name === nextName)
    if (clash) {
      return setError(`${nextName} is bound on ${target?.name} from ${clash.from ?? 'another service'}. A ${noun.toLowerCase()} of that name would be overridden by the binding.`)
    }
    void save(nextName)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${noun}` : `Add ${noun}`}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit}>
          <DialogBody className="flex flex-col gap-4">
            <div className="flex items-center gap-6">
              <label htmlFor="secret-name" className="w-32 shrink-0 text-sm">Name</label>
              <Input id="secret-name" name="name" autoFocus={!editing} disabled={!!editing} placeholder="API_KEY" className="font-mono"
                value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex items-center gap-6">
              <label htmlFor="secret-value" className="w-32 shrink-0 text-sm">Value</label>
              <Input id="secret-value" name="value" type="password" autoFocus={!!editing} placeholder={editing ? 'New value' : 'Value'}
                className="font-mono" value={value} onChange={(e) => setValue(e.target.value)} />
            </div>
            {!fixedService && (
              <div className="flex items-center gap-6">
                <span className="w-32 shrink-0 text-sm">Scope</span>
                <div className="min-w-0 flex-1">
                  <Select value={scope} onValueChange={(v) => setScope(v as SecretScope)} disabled={!!editing}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="env">This branch ({branch})</SelectItem>
                      <SelectItem value="project">All branches</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            {!fixedService && scope === 'env' && services.length > 0 && (
              <div className="flex items-center gap-6">
                <span className="w-32 shrink-0 text-sm">Service</span>
                <div className="min-w-0 flex-1">
                  <Select value={service} onValueChange={setService}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNBOUND}>Not bound (shared)</SelectItem>
                      {services.map((s) => <SelectItem key={s.key} value={s.key}>{s.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              {fixedService
                ? `Saved to ${fixedService.name}'s variables in ${branch}.`
                : 'A branch-scoped value overrides an all-branches value with the same name.'}
              {editing && ' The current value is never shown; this replaces it.'}
            </p>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={!name.trim() || !value || busy}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
