// The console's Observability page (insta-frontend components/project/observability/observability-view.tsx):
// every service in the environment as a line on the same CPU, memory and network cards, with the
// console's time range picker. The roster is what lets a service with no samples draw flat at
// zero instead of vanishing. Self-host: Redis, MySQL and MongoDB services are drawn too, beside
// compute and Postgres (the console has only those two).

import { useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../api'
import { usePoll } from '../hooks'
import { serviceNamesByComponent } from '../lib/metrics'
import { MetricCharts, type MetricSource } from '../components/metrics/MetricCharts'

const COMPONENTS = ['compute', 'db', 'redis', 'mysql', 'mongodb'] as const

export function Usage() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  const { data: services } = usePoll(() => api.services(projectId, branch), [projectId, branch], 30_000)
  const roster = useMemo(() => serviceNamesByComponent(services ?? []), [services])
  // Every component that has services, compute first as on the console. The first is the primary
  // request: always asking for compute made an environment with only databases answer "nothing
  // deployed", and that note replaced every chart, databases included.
  const sources: MetricSource[] = COMPONENTS.flatMap((c) => (roster[c]?.length ? [{ component: c, services: roster[c] }] : []))
  const [primary, ...also] = sources
  const total = sources.reduce((n, s) => n + (s.services?.length ?? 0), 0)

  return (
    <div className="mx-auto flex w-full max-w-[90rem] flex-col">
      <MetricCharts
        projectId={projectId}
        // With nothing deployed there is no source; compute's request then brings the daemon's own note.
        component={primary?.component ?? 'compute'}
        branch={branch}
        services={primary?.services}
        also={also.length ? also : undefined}
        // A lone service keeps the single-line shape and still needs a name.
        lineName={total === 1 ? primary?.services?.[0] : undefined}
        title="Observability"
      />
    </div>
  )
}
