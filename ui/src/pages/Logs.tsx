import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { EmptyState, Tab, Tabs, cn } from '@insforge/ui'
import { Moon, ScrollText } from 'lucide-react'
import { api, obsComponentFor, type LogLine, type ObsComponent } from '../api'
import { usePoll } from '../hooks'
import { healthFor } from '../lib/status'
import { instanceLabel } from '../lib/instanceLabels'
import { ConsolePage } from '../components/console/ConsolePage'

type Component = ObsComponent


function LogRows({ lines }: { lines: LogLine[] }) {
  const bottom = useRef<HTMLDivElement>(null)
  const count = useRef(0)
  useEffect(() => {
    if (lines.length !== count.current) {
      count.current = lines.length
      bottom.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [lines])
  const instances = new Set(lines.map((l) => l.instance))
  return (
    <div className="max-h-[32rem] overflow-auto font-mono text-[13px] leading-6">
      {lines.map((l, i) => (
        <div key={i} className="flex gap-3 px-4 whitespace-pre-wrap hover:bg-alpha-4">
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {l.ts ? l.ts.slice(0, 19).replace('T', ' ') : '—'}
          </span>
          {instances.size > 1 && (
            <span className="shrink-0 text-info">{instanceLabel(l.instance)}</span>
          )}
          <span className="min-w-0 break-all">{l.message}</span>
        </div>
      ))}
      <div ref={bottom} />
    </div>
  )
}

/** The live container tail, for the Logs page and a service's Runtime Logs tab. `service` narrows
 *  it to one service's container. Reading logs never wakes anything. */
export function LogsPanel({ projectId, branch, component, service }: {
  projectId: string; branch: string; component: Component; service?: { name: string; type: string }
}) {
  // Ask the daemon for THIS service's container rather than filtering the component stream here:
  // it truncates the merged stream to the limit before returning it, so a noisy sibling could use
  // up the whole window and leave the selected service reading "No logs yet."
  const { data, error } = usePoll(
    () => api.logs(projectId, component, branch, 200, service?.name),
    [projectId, branch, component, service?.name],
  )
  const { data: services } = usePoll(() => api.services(projectId, branch), [projectId, branch], 15000)
  const { data: health } = usePoll(() => api.runtimeHealth(projectId, branch), [projectId, branch], 15000)

  // Name alone is not a key: a compute service and a database can share one, and then the sleeping
  // banner was decided by both. The selected service is identified by name AND type; the whole-page
  // view takes every service the requested component observes.
  const wanted = (services ?? []).filter((s) => service
    ? s.name === service.name && s.type === service.type
    : obsComponentFor(s.type) === component)
  const standby = wanted.length > 0 && wanted.every((s) => healthFor(health, s.id)?.status === 'standby')
  // No client-side filter: the request is already scoped with `group`, so this could only
  // SUBTRACT, and it did. instanceLabel reduces any container ending in `-pg` to "postgres", so a
  // postgres service actually NAMED "pg" arrived as label "postgres", failed to match the name
  // "pg", and had every one of its own lines dropped.
  const lines = data?.lines

  return (
    <div className="flex flex-col gap-3">
      {standby && (
        <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Moon className="size-3.5" /> Sleeping; showing the last lines before it went to sleep.
        </p>
      )}
      {!data && !error && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={cn('h-4 animate-pulse rounded-md bg-alpha-8', i % 2 ? 'w-3/4' : 'w-full')} />
          ))}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-destructive">{error.message}</div>
      )}
      {lines && lines.length === 0 && (
        <div className="rounded-lg border border-border bg-card py-12">
          <EmptyState icon={ScrollText} title="No logs yet."
            description={component === 'compute'
              ? 'Deploy an app to this branch and its container output lands here.'
              : 'The database has not written any log lines yet.'} />
        </div>
      )}
      {lines && lines.length > 0 && (
        <div className="rounded-lg border border-border bg-card py-2">
          <LogRows lines={lines} />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Tailed live from this branch&apos;s containers ({data?.source ?? 'docker-logs'}); refreshes every 5s.
      </p>
    </div>
  )
}

export function Logs() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  const [component, setComponent] = useState<Component>('compute')
  return (
    <ConsolePage title="Logs"
      action={
        <Tabs value={component} onValueChange={setComponent}>
          <Tab value="compute">App</Tab>
          <Tab value="db">Database</Tab>
        </Tabs>
      }>
      <LogsPanel projectId={projectId} branch={branch} component={component} />
    </ConsolePage>
  )
}
