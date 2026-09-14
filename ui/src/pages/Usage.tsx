// The console's Observability page (insta-frontend components/project/observability/observability-view.tsx):
// every service in the environment as a line on the same CPU, memory and network cards, with the
// 1h / 6h / 24h / 3d range picker. The roster is what lets a service with no samples draw flat at
// zero instead of vanishing. Self-host: Redis, MySQL and MongoDB services are drawn too, beside
// compute and Postgres (the console has only those two).

import { useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../api'
import { usePoll } from '../hooks'
import { serviceNamesByComponent } from '../lib/metrics'
import { MetricCharts, type MetricSource } from '../components/metrics/MetricCharts'

const DATABASES = ['db', 'redis', 'mysql', 'mongodb'] as const

export function Usage() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  const { data: services } = usePoll(() => api.services(projectId, branch), [projectId, branch], 30_000)
  const roster = useMemo(() => serviceNamesByComponent(services ?? []), [services])
  const compute = roster.compute
  const databases: MetricSource[] = DATABASES.flatMap((c) => (roster[c]?.length ? [{ component: c, services: roster[c] }] : []))
  const total = (compute?.length ?? 0) + databases.reduce((n, d) => n + (d.services?.length ?? 0), 0)

  return (
    <div className="mx-auto flex w-full max-w-[90rem] flex-col">
      <MetricCharts
        projectId={projectId}
        component="compute"
        branch={branch}
        services={compute}
        // Only when the environment has a database, else a compute-only one waits on pointless requests.
        also={databases.length ? databases : undefined}
        // A lone service keeps the single-line shape and still needs a name.
        lineName={total === 1 ? (compute?.[0] ?? databases[0]?.services?.[0]) : undefined}
        title="Observability"
      />
    </div>
  )
}
