// The console's Secrets page (insta-frontend secrets/secrets-view.tsx, secret-dialog.tsx,
// secret-actions-menu.tsx): a title band with Add Secret, Service / Shared tabs, search, a service
// filter and sort, per-service cards with a Name / Source / Value table, and a label-left dialog
// (Name, Value, Scope, Service). Self-host divergences: values stay hidden (the dashboard never
// reads a secret value; `insta secrets --print` does), and changes apply immediately instead of
// staging for Deploy.

import { useMemo, useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import {
  Button, cn, Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle, DropdownMenu,
  DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Input, SearchInput, Select, SelectContent, SelectItem,
  SelectTrigger, SelectValue,
} from '@insforge/ui'
import { ArrowDownAZ, ArrowUpZA, Check, ChevronDown, EllipsisVertical, KeyRound, Plus } from 'lucide-react'
import { api, type SecretTree } from '../api'
import { usePoll } from '../hooks'
import { ApprovalPrompt, type PendingApproval } from '../components/ApprovalPrompt'
import { ServiceTypeIcon } from '../components/console/ServiceIcon'
import { ErrorNote } from '../components/ui'


type Scope = 'env' | 'project'
/** `kind` decides both the badge and whether Edit/Delete are offered. 'binding' is platform-owned
 *  like 'managed', but for a different reason and from a different place, so it says so. */
type Kind = 'user' | 'managed' | 'binding'
type Row = { name: string; kind: Kind; scope: Scope; service?: string; from?: string; shadowed?: boolean }
type Group = { key: string; type: string; name: string; rows: Row[] }
type SortOrder = 'az' | 'za'
const SORT_LABELS: Record<SortOrder, string> = { az: 'Name (A–Z)', za: 'Name (Z–A)' }
const UNBOUND = 'none'

function grouped(tree: SecretTree, branch: string): { services: Group[]; shared: Row[] } {
  const env = tree.branches.find((b) => b.name === branch)
  const services: Group[] = (env?.services ?? []).map((s) => {
    const key = `${s.type}/${s.name}`
    // The daemon says which names it minted (secrets/tree `minted`), so ask it rather than guess
    // from the name. Guessing matched only the `*_URL` forms, so the rest of a managed bundle
    // (REDIS_HOST_CACHE and friends) was badged User and offered Edit and Delete: the daemon
    // refuses to edit a reserved name, and the delete removed no user row because there is none.
    const minted = new Set(s.minted)
    // A binding is platform-owned too, and editing or deleting one silently does nothing: Delete
    // calls unsetUserSecret, which never touches a binding, and Edit writes a user row that
    // `envFor` overrides because bindings are applied last. Both reported success.
    const bindings = new Map(s.bindings.map((x) => [x.envName, x]))
    return {
      key, type: s.type, name: s.name,
      rows: s.secrets.map((n) => {
        const bound = bindings.get(n)
        return {
          name: n,
          kind: (minted.has(n) ? 'managed' : bound ? 'binding' : 'user') as Kind,
          scope: 'env' as const,
          service: key,
          ...(bound ? { from: `${bound.source}.${bound.sourceName}`, shadowed: bound.shadowsUserSecret } : {}),
        }
      }),
    }
  })
  const shared: Row[] = [
    ...tree.projectWide.map((n) => ({ name: n, kind: 'user' as const, scope: 'project' as const })),
    ...(env?.unbound ?? []).map((n) => ({ name: n, kind: 'user' as const, scope: 'env' as const })),
  ]
  return { services, shared }
}

function filterAndSort(rows: Row[], query: string, sort: SortOrder): Row[] {
  return rows
    .filter((r) => !query || r.name.toLowerCase().includes(query))
    .sort((a, b) => (sort === 'az' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)))
}

const BADGE: Record<Kind, { label: string; className: string }> = {
  user: { label: 'User', className: 'bg-success/10 text-success' },
  managed: { label: 'Managed', className: 'bg-alpha-8 text-muted-foreground' },
  binding: { label: 'Binding', className: 'bg-alpha-8 text-muted-foreground' },
}

function SourceBadge({ kind, from }: { kind: Kind; from?: string }) {
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

function SecretsTable({ rows, emptyMessage, onEdit, onDelete }: {
  rows: Row[]; emptyMessage: string; onEdit: (row: Row) => void; onDelete: (row: Row) => void
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
                        {/* No Edit on a shadowed binding: the binding is applied last, so an edit
                            would write a user row the container still never sees. Delete is the
                            one action that does something — it removes the dead row underneath. */}
                        {row.kind === 'user' && <DropdownMenuItem onSelect={() => onEdit(row)}>Edit Secret</DropdownMenuItem>}
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onDelete(row)}>
                          {row.shadowed ? 'Delete Shadowed Secret' : 'Delete Secret'}
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

function SecretDialog({ projectId, branch, services, editing, onClose, onDone, onApproval }: {
  projectId: string; branch: string; services: Group[]; editing: Row | null
  onClose: () => void; onDone: () => void; onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const [name, setName] = useState(editing?.name ?? '')
  const [value, setValue] = useState('')
  const [scope, setScope] = useState<Scope>(editing?.scope ?? 'env')
  const [service, setService] = useState(editing?.service ?? UNBOUND)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (nextName: string) => {
    setBusy(true)
    const bound = scope === 'env' && service !== UNBOUND ? service : undefined
    const r = await api.setSecret(projectId, nextName, value, scope === 'env' ? branch : undefined, bound)
    setBusy(false)
    if (r.kind === 'error') return setError(r.error)
    // Close on success only: closing first sent a failed approval-retry's error to a dialog that
    // was no longer mounted.
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void save(nextName) } })
    onClose()
    onDone()
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    const nextName = name.trim()
    // Only what the daemon itself refuses. The dialog used to demand SCREAMING_SNAKE_CASE within
    // 64 characters and cap the value at 8 KiB, none of which the daemon enforces, so a secret
    // created with the CLI could be listed here and then not edited: the form rejected its own
    // existing name. An env var name cannot be empty or contain `=`; that is the real floor.
    if (!nextName) return setError('A name is required.')
    if (nextName.includes('=')) return setError('A secret name cannot contain "=".')
    // The other door onto the same trap the row actions close: a name a BINDING already maps into
    // the selected service can be written as a user secret, and `envFor` applies bindings last, so
    // the container keeps the bound value and the row you just created does nothing. The daemon
    // allows it (bindings bypass `isReservedSecret` by design), so say so here rather than write a
    // secret that silently loses.
    const target = scope === 'env' && service !== UNBOUND ? services.find((g) => g.key === service) : undefined
    const clash = target?.rows.find((r) => r.kind === 'binding' && r.name === nextName)
    if (clash) {
      return setError(`${nextName} is bound on ${target?.name} from ${clash.from ?? 'another service'}. A secret of that name would be overridden by the binding.`)
    }
    void save(nextName)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit Secret' : 'Add Secret'}</DialogTitle>
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
            <div className="flex items-center gap-6">
              <span className="w-32 shrink-0 text-sm">Scope</span>
              <div className="min-w-0 flex-1">
                <Select value={scope} onValueChange={(v) => setScope(v as Scope)} disabled={!!editing}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="env">This branch ({branch})</SelectItem>
                    <SelectItem value="project">All branches</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {scope === 'env' && services.length > 0 && (
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
              A branch-scoped value overrides an all-branches value with the same name.
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

/** The environment's secret inventory: NAMES ONLY (values stay behind `insta secrets`, which is
 *  secrets.read-gated). Managed service credentials are read-only; user secrets are editable. */
export function Secrets() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  // 30s poll: /secrets/tree is names-only and emits no audit event.
  const { data, error, reload } = usePoll(() => api.secretTree(projectId), [projectId], 30000)
  const [dialog, setDialog] = useState<{ editing: Row | null } | null>(null)
  const [approval, setApproval] = useState<PendingApproval>(null)
  const [actionError, setActionError] = useState<string>()
  const [tab, setTab] = useState<'service' | 'shared'>('service')
  const [search, setSearch] = useState('')
  const [serviceFilter, setServiceFilter] = useState('all')
  const [sort, setSort] = useState<SortOrder>('az')

  const query = search.trim().toLowerCase()
  const all = useMemo(() => (data ? grouped(data, branch) : { services: [], shared: [] }), [data, branch])
  const withSecrets = all.services.filter((g) => g.rows.length > 0)
  const activeFilter = withSecrets.some((g) => g.key === serviceFilter) ? serviceFilter : 'all'
  const serviceGroups = withSecrets
    .filter((g) => activeFilter === 'all' || g.key === activeFilter)
    .map((g) => ({ ...g, rows: filterAndSort(g.rows, query, sort) }))
    .filter((g) => g.rows.length > 0)
  const sharedRows = filterAndSort(all.shared, query, sort)

  const remove = async (row: Row) => {
    setActionError(undefined)
    // One user secret per name per environment (the daemon keys them that way), so the name and
    // scope identify the row whatever service it is bound to.
    const r = await api.unsetSecret(projectId, row.name, row.scope === 'env' ? branch : undefined)
    if (r.kind === 'approval') return setApproval({ ...r, retry: () => { void remove(row) } })
    if (r.kind === 'error') return setActionError(r.error)
    reload()
  }

  return (
    <div className="relative -mx-8 -mt-8 flex w-auto flex-col gap-4">
      <div className="px-6">
        <div className="flex flex-col gap-1 py-4.5">
          <h1 className="text-[32px] leading-12 font-semibold">Secrets</h1>
          <p className="text-[13px] text-muted-foreground">
            Branch variables for <span className="font-medium">{branch}</span> — managed service credentials plus your
            user-defined secrets
          </p>
        </div>
      </div>
      <div className="absolute top-6 right-6 z-10">
        <Button variant="primary" className="h-9 gap-1.5" onClick={() => setDialog({ editing: null })}>
          <Plus className="size-4" />
          Add Secret
        </Button>
      </div>

      <div className="flex flex-col gap-3 px-6">
        <div role="tablist" className="flex gap-6 border-b border-border">
          {([{ id: 'service', label: 'Service' }, { id: 'shared', label: 'Shared' }] as const).map(({ id, label }) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={cn('-mb-px flex flex-col gap-3 pt-0.5 text-[13px] transition-colors',
                tab === id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {label}
              <span className={cn('h-0.5 w-full', tab === id ? 'bg-foreground' : 'bg-transparent')} />
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search variables" className="w-64" debounceTime={0} />
          {tab === 'service' && (
            <div className="w-55">
              <Select value={activeFilter} onValueChange={setServiceFilter}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Services</SelectItem>
                  {withSecrets.map((g) => <SelectItem key={g.key} value={g.key}>{g.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="sm" className="h-8 gap-1.5">
                {sort === 'az' ? <ArrowDownAZ className="size-4 text-muted-foreground" /> : <ArrowUpZA className="size-4 text-muted-foreground" />}
                {SORT_LABELS[sort]}
                <ChevronDown className="size-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {(Object.keys(SORT_LABELS) as SortOrder[]).map((order) => (
                <DropdownMenuItem key={order} onSelect={() => setSort(order)}>
                  <Check className={order === sort ? 'size-4 shrink-0' : 'invisible size-4 shrink-0'} />
                  {SORT_LABELS[order]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {tab === 'service' ? (
          serviceGroups.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card px-6 py-12 text-center">
              <KeyRound className="size-6 text-muted-foreground" />
              <p className="text-sm font-medium">{query ? 'No matches' : all.services.length === 0 ? 'No services yet' : 'No service secrets yet'}</p>
              <p className="text-[13px] text-muted-foreground">
                {query ? 'No variables match your search.'
                  : all.services.length === 0 ? 'Service credentials appear here once a service is added to this branch.'
                    : 'Services appear here once they mint credentials or you bind a secret to one.'}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {serviceGroups.map((g) => (
                <div key={g.key} className="rounded-lg border border-border bg-card">
                  <div className="flex items-center gap-3 p-2">
                    <span className="flex size-8 items-center justify-center rounded-md bg-semantic-1">
                      <ServiceTypeIcon type={g.type} className="size-5" />
                    </span>
                    <span className="truncate text-sm">{g.name}</span>
                  </div>
                  <div className="px-2 pb-2">
                    <SecretsTable rows={g.rows} emptyMessage="No secrets bound to this service yet."
                      onEdit={(row) => setDialog({ editing: row })} onDelete={(row) => { void remove(row) }} />
                  </div>
                </div>
              ))}
            </div>
          )
        ) : (
          <div className="rounded-lg border border-border bg-card p-2">
            <SecretsTable rows={sharedRows} emptyMessage={query ? 'No variables match your search.' : 'No shared secrets yet.'}
              onEdit={(row) => setDialog({ editing: row })} onDelete={(row) => { void remove(row) }} />
          </div>
        )}
        <ErrorNote error={actionError ?? error} />
        <p className="text-xs text-muted-foreground">
          Names only. Values stay behind <span className="font-mono">insta secrets</span>.
        </p>
      </div>

      {dialog && (
        <SecretDialog projectId={projectId} branch={branch} services={all.services} editing={dialog.editing}
          onClose={() => setDialog(null)} onDone={reload} onApproval={setApproval} />
      )}
      <ApprovalPrompt projectId={projectId} pending={approval} onClose={() => setApproval(null)} />
    </div>
  )
}
