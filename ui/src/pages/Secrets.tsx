// The console's Secrets page (insta-frontend secrets/secrets-view.tsx, secret-dialog.tsx,
// secret-actions-menu.tsx): a title band with Add Secret, Service / Shared tabs, search, a service
// filter and sort, per-service cards with a Name / Source / Value table, and a label-left dialog
// (Name, Value, Scope, Service). The table, badge and dialog are shared with a service's Variables
// tab (components/console/SecretParts.tsx). Self-host divergences: values stay hidden (the dashboard
// never reads a secret value; `insta secrets --print` does), and changes apply immediately instead of
// staging for Deploy.

import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  Button, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, SearchInput, Select,
  SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@insforge/ui'
import { ArrowDownAZ, ArrowUpZA, Check, ChevronDown, KeyRound, Plus } from 'lucide-react'
import { api } from '../api'
import { usePoll } from '../hooks'
import { ApprovalPrompt, type PendingApproval } from '../components/ApprovalPrompt'
import { SecretDialog, SecretsTable } from '../components/console/SecretParts'
import { ServiceTypeIcon } from '../components/console/ServiceIcon'
import { ErrorNote } from '../components/ui'
import { filterAndSort, groupSecrets, SORT_LABELS, type SecretRow, type SortOrder } from '../lib/secretRows'

/** The environment's secret inventory: NAMES ONLY (values stay behind `insta secrets`, which is
 *  secrets.read-gated). Managed service credentials are read-only; user secrets are editable. */
export function Secrets() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  // 30s poll: /secrets/tree is names-only and emits no audit event.
  const { data, error, reload } = usePoll(() => api.secretTree(projectId), [projectId], 30000)
  const [dialog, setDialog] = useState<{ editing: SecretRow | null } | null>(null)
  const [approval, setApproval] = useState<PendingApproval>(null)
  const [actionError, setActionError] = useState<string>()
  const [tab, setTab] = useState<'service' | 'shared'>('service')
  const [search, setSearch] = useState('')
  const [serviceFilter, setServiceFilter] = useState('all')
  const [sort, setSort] = useState<SortOrder>('az')

  const query = search.trim().toLowerCase()
  const all = useMemo(() => (data ? groupSecrets(data, branch) : { services: [], shared: [] }), [data, branch])
  const withSecrets = all.services.filter((g) => g.rows.length > 0)
  const activeFilter = withSecrets.some((g) => g.key === serviceFilter) ? serviceFilter : 'all'
  const serviceGroups = withSecrets
    .filter((g) => activeFilter === 'all' || g.key === activeFilter)
    .map((g) => ({ ...g, rows: filterAndSort(g.rows, query, sort) }))
    .filter((g) => g.rows.length > 0)
  const sharedRows = filterAndSort(all.shared, query, sort)

  const remove = async (row: SecretRow) => {
    setActionError(undefined)
    // A branch row names its service (or none), so only that copy goes: the delete used to send the name and branch
    // alone, and the daemon removed every service's secret of that name with it.
    const r = await api.unsetSecret(projectId, row.name, row.scope === 'env' ? branch : undefined, row.service ?? null)
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
