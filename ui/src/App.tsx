import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { Button } from '@insforge/ui'
import { api } from './api'
import { usePoll } from './hooks'
import { AuthGate } from './components/AuthGate'
import { Layout } from './components/Layout'
import { Services } from './pages/Services'
import { Templates } from './pages/Templates'
import { Environments } from './pages/Environments'
import { Logs } from './pages/Logs'
import { Secrets } from './pages/Secrets'
import { DatabaseInsight } from './pages/DatabaseInsight'
import { Operations } from './pages/Operations'
import { Usage } from './pages/Usage'
import { Approvals } from './pages/Approvals'
import { Settings } from './pages/Settings'
import { QuickStart } from './pages/QuickStart'
import { Setup } from './pages/Setup'
import { Login } from './pages/Login'
import { Tokens } from './pages/Tokens'

/** Lands on the first project's default branch (or an empty state if none exist yet). */
function Home() {
  const { data: projects, error } = usePoll(api.projects, [])
  if (error) return <CenterNote title="daemon unreachable" body="Is instad running? Start it with: npm run dev" />
  if (!projects) return null
  if (!projects.length) {
    return <CenterNote title="No projects yet" body="Create one and it appears here: insta project create <name>" />
  }
  return <ProjectRedirect projectId={projects[0].id} />
}

function ProjectRedirect({ projectId }: { projectId: string }) {
  const { data: branches, error, reload } = usePoll(() => api.branches(projectId), [projectId])
  // A link to a project that has since been deleted used to render nothing at all, forever: the
  // lookup rejects and there is no branch to redirect to. Only a 404 means deleted, though.
  // Treating EVERY failure as deletion sent a network blip, an auth race or a daemon 5xx back to
  // Home, which redirects into the project again: a loop instead of the actual error.
  const status = (error as (Error & { status?: number }) | undefined)?.status
  if (status === 404) return <Navigate to="/" replace />
  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">{error.message}</p>
        <Button variant="secondary" onClick={reload}>Try again</Button>
      </div>
    )
  }
  if (!branches) return null
  const def = branches.find((b) => b.is_default) ?? branches[0]
  return <Navigate to={`/p/${projectId}/${encodeURIComponent(def?.name ?? 'main')}/services`} replace />
}

function CenterNote({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 font-mono text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}

function ProjectShell() {
  const { projectId } = useParams()
  if (!projectId) return <Navigate to="/" replace />
  return <Layout />
}

/** `services/<id>`: the old detail page's links open the console-style overlay instead. */
function ServiceLink() {
  const { projectId, branch, sid } = useParams()
  return <Navigate to={`/p/${projectId}/${branch}/services?service=${encodeURIComponent(sid ?? '')}`} replace />
}

/** `/p/<id>`: the project switcher's target, which lands on that project's default environment. */
function ProjectIndex() {
  const { projectId } = useParams()
  if (!projectId) return <Navigate to="/" replace />
  return <ProjectRedirect projectId={projectId} />
}

export default function App() {
  return (
    <AuthGate>
      <Routes>
        <Route path="/" element={<Home />} />
        {/* Server-mode identity pages; each redirects home in local mode. */}
        <Route path="/setup" element={<Setup />} />
        <Route path="/login" element={<Login />} />
        <Route path="/account/tokens" element={<Tokens />} />
        <Route path="/p/:projectId" element={<ProjectIndex />} />
        <Route path="/p/:projectId/:branch" element={<ProjectShell />}>
          <Route index element={<Navigate to="services" replace />} />
          <Route path="services" element={<Services />} />
          {/* Branch-scoped, opaque service id (decision 49); the `:` in it is path-safe. */}
          <Route path="services/:sid" element={<ServiceLink />} />
          <Route path="templates" element={<Templates />} />
          <Route path="branches" element={<Environments />} />
          {/* Bookmarks from when this page was Environments, at env. */}
          <Route path="env" element={<Navigate to="../branches" replace />} />
          <Route path="logs" element={<Logs />} />
          <Route path="secrets" element={<Secrets />} />
          <Route path="database" element={<DatabaseInsight />} />
          <Route path="operations" element={<Operations />} />
          {/* The console's Observability entry; `usage` stays for bookmarks. */}
          <Route path="observability" element={<Usage />} />
          <Route path="usage" element={<Navigate to="../observability" replace />} />
          <Route path="approvals" element={<Approvals />} />
          <Route path="quick-start" element={<QuickStart />} />
          <Route path="settings" element={<Settings />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthGate>
  )
}
