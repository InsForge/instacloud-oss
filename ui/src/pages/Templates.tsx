import { useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Badge, Button, cn, SearchInput } from '@insforge/ui'
import { ExternalLink } from 'lucide-react'
import { api, type TemplateDetail, type TemplateListItem } from '../api'
import { usePoll } from '../hooks'
import { ALL_CATEGORIES, categoryCounts, filterTemplates, runsHere } from '../lib/catalog'
import { flattenVariables } from '../lib/templateVars'
import { ApprovalPrompt, type PendingApproval } from '../components/ApprovalPrompt'
import { DeployDialog } from '../components/DeployDialog'
import { Markdown } from '../components/Markdown'
import { categoryLabel, ErrorNote, Modal, TemplateLogo } from '../components/ui'
import { ConsolePage } from '../components/console/ConsolePage'

/** The bundled catalog (plan 07 I): `GET /templates` reads the images and manifests shipped with
 *  the daemon, so the gallery works with no network. Logos arrive as data: URIs (decision 29). */
export function Templates() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  const { data, error } = usePoll(api.templates, [], 60000)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState(ALL_CATEGORIES)
  // `?template=<code>` opens that template's detail, the target of Quick Start's "Deploy your agents"
  // card. Read once, then dropped from the URL, so closing the dialog does not reopen it on refresh.
  const [params, setParams] = useSearchParams()
  const [openCode, setOpenCode] = useState<string | undefined>(() => params.get('template') || undefined)
  useEffect(() => {
    if (!params.has('template')) return
    // Also when the parameter arrives while this page is already mounted, not only at first render.
    const code = params.get('template')
    if (code) setOpenCode(code)
    setParams((prev) => { const next = new URLSearchParams(prev); next.delete('template'); return next }, { replace: true })
  }, [params, setParams])
  const [deployCode, setDeployCode] = useState<string>()
  const [approval, setApproval] = useState<PendingApproval>(null)

  const items = data ?? []
  const rail = useMemo(() => categoryCounts(items), [items])
  const shown = useMemo(() => filterTemplates(items, query, category), [items, query, category])

  return (
    <ConsolePage title="Templates"
      subtitle={<>Ready-made services, deployed into <span className="font-medium">{branch}</span> with their own credentials</>}>

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={query} onChange={setQuery} placeholder="Search templates" className="w-72" debounceTime={0} />
        <div className="flex flex-wrap gap-1.5">
          {rail.map((c) => (
            <button key={c.key} type="button" onClick={() => setCategory(c.key)}
              className={cn('rounded-md px-2 py-1 text-xs font-medium capitalize transition-colors',
                category === c.key ? 'bg-alpha-8 text-foreground' : 'text-muted-foreground hover:bg-alpha-4')}>
              {c.key === ALL_CATEGORIES ? 'All' : categoryLabel(c.key)} <span className="text-muted-foreground">{c.count}</span>
            </button>
          ))}
        </div>
      </div>

      <ErrorNote error={error} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((t) => <Card key={t.code} t={t} onOpen={() => setOpenCode(t.code)} />)}
      </div>
      {data && shown.length === 0 && (
        <p className="text-sm text-muted-foreground">No template matches that search.</p>
      )}

      {openCode && (
        <DetailDialog code={openCode} branch={branch} onClose={() => setOpenCode(undefined)}
          onDeploy={() => { setDeployCode(openCode); setOpenCode(undefined) }} />
      )}
      {deployCode && (
        <DeployDialog projectId={projectId} branch={branch} services={[]} initialLane="template"
          initialTemplateCode={deployCode} onClose={() => setDeployCode(undefined)} onDone={() => {}}
          onApproval={setApproval} />
      )}
      <ApprovalPrompt projectId={projectId} pending={approval} onClose={() => setApproval(null)} />
    </ConsolePage>
  )
}

function Card({ t, onOpen }: { t: TemplateListItem; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen}
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-alpha-4">
      <div className="flex items-center gap-3">
        <TemplateLogo src={t.logoUrl} name={t.name} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{t.name}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{t.code}</p>
        </div>
      </div>
      <p className="line-clamp-2 text-xs text-muted-foreground">{t.tagline}</p>
      <div className="mt-auto flex items-center gap-2 pt-1">
        <Badge variant="default" className="capitalize">{categoryLabel(t.category)}</Badge>
        <span className="font-mono text-[11px] text-muted-foreground">v{t.version}</span>
        {!runsHere(t) && <ArchBadge architectures={t.architectures} host={t.hostArchitecture} />}
        {t.license && <span className="ml-auto text-[11px] text-muted-foreground">{t.license}</span>}
      </div>
    </button>
  )
}

/** Shown only when the answer is no, so the common case stays uncluttered: on a box that can run
 *  everything the gallery looks exactly as it did. */
function ArchBadge({ architectures, host }: { architectures?: string[] | null; host?: string }) {
  return (
    <Badge variant="default" className="font-mono" title={`This machine is ${host}`}>
      {(architectures ?? []).join('/')} only
    </Badge>
  )
}

function DetailDialog({ code, branch, onClose, onDeploy }: {
  code: string; branch: string; onClose: () => void; onDeploy: () => void
}) {
  const { data: detail, error } = usePoll(() => api.template(code), [code], 60000)
  return (
    <Modal
      title={detail?.name ?? code}
      wide
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={onDeploy} disabled={!detail || !runsHere(detail)}>Deploy to {branch}</Button>
        </>
      }
    >
      {error && <ErrorNote error={error} />}
      {!detail ? (
        <p className="text-sm text-muted-foreground">Loading the template...</p>
      ) : (
        <>
          {!runsHere(detail) && (
            <p className="mb-3 rounded-md border border-border bg-alpha-4 p-3 text-xs text-muted-foreground">
              This template publishes {(detail.architectures ?? []).join(' and ')} images and this machine is{' '}
              <span className="font-mono">{detail.hostArchitecture}</span>, so there is no image to pull. Deploying it
              would be refused. Run it on {(detail.architectures ?? []).join(' or ')} hardware instead.
            </p>
          )}
          <DetailBody detail={detail} />
        </>
      )}
    </Modal>
  )
}

function DetailBody({ detail }: { detail: TemplateDetail }) {
  const vars = useMemo(() => flattenVariables(detail), [detail])
  const services = Object.entries(detail.services ?? {})
  return (
    <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
      <div className="flex items-start gap-3">
        <TemplateLogo src={detail.logoUrl} name={detail.name} className="size-10" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted-foreground">{detail.tagline}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge variant="default" className="font-mono">{detail.code}@{detail.version}</Badge>
            <Badge variant="default" className="capitalize">{categoryLabel(detail.category)}</Badge>
            {detail.license && <span className="text-[11px] text-muted-foreground">{detail.license}</span>}
            {detail.maintainer && <span className="text-[11px] text-muted-foreground">by {detail.maintainer}</span>}
          </div>
        </div>
      </div>

      {(detail.source || detail.documentationUrl || detail.upstream?.repo) && (
        <div className="flex flex-wrap gap-3 text-xs">
          {[
            { href: detail.source, label: 'Source' },
            { href: detail.documentationUrl, label: 'Documentation' },
            { href: detail.upstream?.repo, label: 'Upstream' },
          ].filter((l): l is { href: string; label: string } => typeof l.href === 'string' && !!l.href).map((l) => (
            <a key={l.label} href={l.href} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1 text-foreground hover:underline">
              {l.label} <ExternalLink className="size-3 text-muted-foreground" />
            </a>
          ))}
        </div>
      )}

      {services.length > 0 && (
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Services</p>
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-3 font-normal">Name</th>
                <th className="py-1 pr-3 font-normal">Type</th>
                <th className="py-1 pr-3 font-normal">Image</th>
                <th className="py-1 font-normal">Port</th>
              </tr>
            </thead>
            <tbody>
              {services.map(([name, s]) => (
                <tr key={name} className="border-t border-border">
                  <td className="py-1.5 pr-3 font-mono">{name}</td>
                  <td className="py-1.5 pr-3">{s.type}</td>
                  <td className="max-w-64 truncate py-1.5 pr-3 font-mono" title={s.image}>{s.image ?? '—'}</td>
                  <td className="py-1.5 font-mono">{s.port ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {vars.length > 0 && (
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Variables</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {vars.map((v) => (
              <li key={v.name} className="text-xs">
                <span className="font-mono text-foreground">{v.name}</span>
                {v.mustFill && <span className="ml-1 text-destructive">required</span>}
                {v.generate && <span className="ml-1 text-muted-foreground">generated if blank</span>}
                {v.description && <span className="ml-1 text-muted-foreground">{v.description}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {detail.readme && (
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Readme</p>
          <Markdown source={detail.readme} className="mt-2" />
        </div>
      )}
    </div>
  )
}
