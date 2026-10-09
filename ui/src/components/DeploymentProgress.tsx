import { useEffect, useRef, useState } from 'react'
import { Badge, cn } from '@insforge/ui'
import { Check, Circle, ExternalLink, Loader2, X } from 'lucide-react'
import { api, type TemplateDeployment } from '../api'
import {
  DEPLOY_STEPS, MAX_WAIT_MS, POLL_MS, STEP_LABEL, isTerminal, normalizeServices, statusLine, stepMarks,
  type DeploymentService, type StepMark,
} from '../lib/deployment'

/** Poll one template deployment every 2 s (the CLI's cadence) until it settles or 15 min pass. */
export function useDeployment(id: string): { dep: TemplateDeployment | undefined; error: string | undefined; timedOut: boolean } {
  const [dep, setDep] = useState<TemplateDeployment>()
  const [error, setError] = useState<string>()
  const [timedOut, setTimedOut] = useState(false)
  const started = useRef(Date.now())
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const d = await api.templateDeployment(id)
        if (!alive) return
        setDep(d); setError(undefined)
        if (isTerminal(d.status)) return
      } catch (e) {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
      }
      if (Date.now() - started.current > MAX_WAIT_MS) { setTimedOut(true); return }
      timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [id])
  return { dep, error, timedOut }
}

function StepIcon({ mark }: { mark: StepMark }) {
  if (mark === 'done') return <span className="flex size-5 items-center justify-center rounded-full bg-success text-inverse"><Check className="size-3" /></span>
  if (mark === 'active') return <span className="flex size-5 items-center justify-center rounded-full border border-info text-info"><Loader2 className="size-3 animate-spin" /></span>
  if (mark === 'failed') return <span className="flex size-5 items-center justify-center rounded-full bg-destructive text-inverse"><X className="size-3" /></span>
  return <span className="flex size-5 items-center justify-center rounded-full border border-border text-muted-foreground"><Circle className="size-2" /></span>
}

function ServiceStateBadge({ state }: { state: DeploymentService['state'] }) {
  const cls = state === 'healthy' ? 'bg-success text-inverse' : state === 'failed' ? 'bg-destructive text-inverse' : 'bg-semantic-1 text-muted-foreground'
  return <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium', cls)}>{state}</span>
}

/** The four-step ladder, the services with their states and URLs, and the failure tail. */
export function DeploymentProgress({ dep, error, timedOut }: { dep: TemplateDeployment | undefined; error?: string; timedOut?: boolean }) {
  const marks = stepMarks(dep?.status, dep?.step)
  const services = normalizeServices(dep?.services)
  const failed = dep?.status === 'failed' || dep?.status === 'partial'
  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-2">
        {DEPLOY_STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-3 text-sm">
            <StepIcon mark={marks[i]} />
            <span className={cn(marks[i] === 'pending' ? 'text-muted-foreground' : 'text-foreground')}>{STEP_LABEL[s]}</span>
          </li>
        ))}
      </ol>

      {services.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border">
          {services.map((s) => (
            <div key={s.name} className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
              <span className="font-mono text-sm">{s.name}</span>
              <ServiceStateBadge state={s.state} />
              {s.url && (
                <a href={s.url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 truncate font-mono text-xs text-foreground hover:underline">
                  <span className="truncate">{s.url}</span>
                  <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      <p className={cn('text-sm', failed ? 'text-destructive' : 'text-muted-foreground')}>
        {timedOut && !isTerminal(dep?.status) ? 'Still running after 15 minutes; check back on the Services page.' : statusLine(dep?.status)}
        {dep?.templateCode && dep.templateVersion && <Badge variant="default" className="ml-2">{dep.templateCode}@{dep.templateVersion}</Badge>}
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {dep?.error && <p className="text-sm text-destructive">{dep.error}</p>}
      {dep?.logsTail && (
        <pre className="max-h-48 overflow-auto rounded-md border border-border bg-semantic-1 p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap">{dep.logsTail}</pre>
      )}
    </div>
  )
}
