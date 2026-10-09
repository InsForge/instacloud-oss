import { useState } from 'react'
import { Button, cn, ConfirmDialog, CopyButton, Input } from '@insforge/ui'
import { Globe, RefreshCw } from 'lucide-react'
import { api, type DomainResult } from '../api'
import { usePoll } from '../hooks'
import { HOSTNAME_RE, STAGE_LABEL, domainStage, normalizeHostInput, stageHint, type DomainStage } from '../lib/domains'
import { ApprovalPrompt, type PendingApproval } from './ApprovalPrompt'
import { ErrorNote, Section } from './ui'

function StageBadge({ stage }: { stage: DomainStage }) {
  const cls = stage === 'active' ? 'bg-success text-inverse'
    : stage === 'error' ? 'bg-destructive text-inverse'
    : stage === 'verifying' ? 'bg-info text-inverse'
    : 'bg-warning text-inverse'
  return <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium', cls)}>{STAGE_LABEL[stage]}</span>
}

function DomainCard({ r, onVerify, onRemove, verifying }: {
  r: DomainResult; onVerify: () => void; onRemove: () => void; verifying: boolean
}) {
  const stage = domainStage(r)
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <Globe className="size-4 text-muted-foreground" />
        <span className="font-mono text-sm font-medium">{r.hostname}</span>
        <StageBadge stage={stage} />
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={onVerify} disabled={verifying}>
            <RefreshCw className={cn('size-3.5', verifying && 'animate-spin')} /> Verify
          </Button>
          <Button variant="ghost" size="sm" className="text-xs text-destructive" onClick={onRemove}>Remove</Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{stageHint(r)}</p>
      {(r.dns ?? []).length > 0 && (
        <table className="mt-2 w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-3 font-normal">Type</th>
              <th className="py-1 pr-3 font-normal">Name</th>
              <th className="py-1 pr-3 font-normal">Value</th>
              <th className="py-1 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {(r.dns ?? []).map((d, i) => (
              <tr key={i} className="border-t border-border">
                <td className="py-1.5 pr-3 font-mono">{d.type}</td>
                <td className="py-1.5 pr-3 font-mono">{d.name}</td>
                <td className="py-1.5 pr-3">
                  <span className="inline-flex items-center gap-1 font-mono"><span>{d.value}</span><CopyButton text={d.value} /></span>
                  {d.note && <p className="text-[11px] text-muted-foreground">{d.note}</p>}
                </td>
                <td className={cn('py-1.5', d.status === 'ok' ? 'text-success' : d.status === 'mismatch' ? 'text-destructive' : 'text-muted-foreground')}>
                  {d.status ?? 'unchecked'}
                  {d.status === 'mismatch' && <span className="block text-[11px] text-muted-foreground">expected {d.value}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** Custom domains for one compute service (plan 07 G): the cloud's four compute/domain routes.
 *  Rendered in server mode only (the parent hides it in local mode, decision 25). */
export function DomainsSection({ projectId, branch, group }: { projectId: string; branch: string; group: string }) {
  const { data, error, reload } = usePoll(() => api.domains(projectId, branch, group), [projectId, branch, group], 30000)
  const [items, setItems] = useState<Record<string, DomainResult>>({})
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [verifying, setVerifying] = useState<string | null>(null)
  const [removing, setRemoving] = useState<DomainResult | null>(null)
  const [approval, setApproval] = useState<PendingApproval>(null)
  const [actionError, setActionError] = useState<string>()

  // The list is the source of truth; a Verify answer overlays one row until the next list read.
  const rows = (data ?? []).map((r) => items[r.hostname] ?? r)
  const host = normalizeHostInput(input)
  const valid = HOSTNAME_RE.test(host)

  const add = async () => {
    if (!valid) return setActionError('Enter a full hostname, like shop.example.com.')
    setBusy(true); setActionError(undefined)
    const r = await api.addDomain(projectId, { hostname: host, branch, group })
    setBusy(false)
    if (r.kind === 'error') return setActionError(r.error)
    if (r.kind === 'approval') return setApproval({ ...r, retry: add })
    setInput(''); setItems((m) => ({ ...m, [r.data.hostname]: r.data })); reload()
  }

  const verify = async (hostname: string) => {
    setVerifying(hostname); setActionError(undefined)
    try {
      const r = await api.domainStatus(projectId, { hostname, branch, group })
      setItems((m) => ({ ...m, [hostname]: r }))
    } catch (e) { setActionError(e instanceof Error ? e.message : String(e)) }
    setVerifying(null)
  }

  const remove = async () => {
    if (!removing) return
    const hostname = removing.hostname
    setBusy(true); setActionError(undefined)
    const r = await api.removeDomain(projectId, { hostname, branch, group })
    setBusy(false); setRemoving(null)
    if (r.kind === 'error' && r.status !== 404) return setActionError(r.error)
    if (r.kind === 'approval') return setApproval({ ...r, retry: () => { setRemoving({ hostname }); void remove() } })
    setItems((m) => { const n = { ...m }; delete n[hostname]; return n }); reload()
  }

  return (
    <Section title="Domains" description="Point your own hostname at this service. Add a CNAME to the daemon and the edge issues a certificate.">
      <div className="flex gap-2">
        <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="shop.example.com" className="font-mono"
          onKeyDown={(e) => e.key === 'Enter' && add()} />
        <Button variant="primary" onClick={add} disabled={busy || !valid}>Add</Button>
      </div>
      {input && !valid && <p className="mt-1 text-xs text-destructive">Not a valid hostname.</p>}
      <div className="mt-3 flex flex-col gap-2">
        {rows.map((r) => (
          <DomainCard key={r.hostname} r={r} verifying={verifying === r.hostname}
            onVerify={() => verify(r.hostname)} onRemove={() => setRemoving(r)} />
        ))}
        {data && rows.length === 0 && <p className="text-xs text-muted-foreground">No custom domains yet.</p>}
      </div>
      <ErrorNote error={actionError ?? error} />
      <ConfirmDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} title="Remove domain"
        description={`${removing?.hostname ?? 'This hostname'} stops routing to ${group} immediately.`}
        confirmText="Remove" destructive isLoading={busy} onConfirm={remove} />
      <ApprovalPrompt projectId={projectId} pending={approval} onClose={() => setApproval(null)} />
    </Section>
  )
}
