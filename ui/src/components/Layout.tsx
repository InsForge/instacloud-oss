// The project shell, ported from the console (insta-frontend app/projects/[id]/layout.tsx,
// project-sidebar.tsx, project-topbar.tsx): a fixed viewport where only <main> scrolls; the
// collapsible sidebar with the project switcher at its head; a 48px topbar with the branch switcher
// on the left and the Activities, Notifications and account cells on the right; the Activities or
// Notifications panel docked to the right of the content, pushing it aside rather than covering it; and
// the pending-review stack over the top right of the content; and Settings as a modal over whatever page
// is open (`?panel=settings`, ProjectSettingsPanel.tsx).
//
// Sidebar, as the console orders it: Service, Observability, Secrets | Branches | Quick Start,
// Settings. Self-host divergences: no Usage (billing) entry; Observability opens the live CPU/memory
// page. Logs and Database live in the service detail, as they do on the console.

import { useState } from 'react'
import { Outlet, useLocation, useParams } from 'react-router-dom'
import { Activity, Box, Download, KeyRound, Settings, Settings2, type LucideIcon } from 'lucide-react'
import { AppSidebar, SidebarDivider, SidebarLink } from './console/AppSidebar'
import { ProjectSwitcher, TopbarProjectSwitcher } from './console/ProjectSwitcher'
import { EnvSwitcher } from './console/EnvSwitcher'
import { ActivitiesButton, ActivitiesPanel } from './console/ActivitiesButton'
import { NotificationsButton, NotificationsPanel, ReviewNotificationStack } from './console/NotificationsPanel'
import { AccountMenu } from './console/AccountMenu'
import { ProjectSettingsPanel } from './console/ProjectSettingsPanel'
import { api } from '../api'
import { usePoll } from '../hooks'
import { pendingCount, reviewsFor, type Decisions, type ReviewDecision } from '../lib/notifications'
import { withSettings } from '../lib/panels'

type NavItem = { label: string; segment: string; icon: LucideIcon }

const primaryNav: NavItem[] = [
  { label: 'Service', segment: 'services', icon: Box },
  { label: 'Observability', segment: 'observability', icon: Activity },
  { label: 'Secrets', segment: 'secrets', icon: KeyRound },
]
const envNav: NavItem[] = [{ label: 'Branches', segment: 'branches', icon: Settings2 }]
const bottomNav: NavItem[] = [
  { label: 'Quick Start', segment: 'quick-start', icon: Download },
  { label: 'Settings', segment: 'settings', icon: Settings },
]

function ProjectSidebar({ projectId, branch }: { projectId: string; branch: string }) {
  const { pathname, search } = useLocation()
  const base = `/p/${projectId}/${branch}`
  const settingsOpen = new URLSearchParams(search).get('panel') === 'settings'
  const item = ({ label, segment, icon }: NavItem) => {
    // Settings opens the console's panel over the page you are on, not a page of its own.
    if (segment === 'settings') {
      return <SidebarLink key={label} to={`${pathname}${withSettings(search)}`} icon={icon} label={label} active={settingsOpen} />
    }
    const to = `${base}/${segment}`
    const active = !settingsOpen && (pathname === to || pathname.startsWith(`${to}/`))
    return <SidebarLink key={label} to={to} icon={icon} label={label} active={active} />
  }
  return (
    <AppSidebar>
      <ProjectSwitcher projectId={projectId} />
      <nav className="flex flex-1 flex-col">
        {primaryNav.map(item)}
        <SidebarDivider />
        {envNav.map(item)}
        <div className="flex-1" />
        <SidebarDivider />
        {bottomNav.map(item)}
      </nav>
    </AppSidebar>
  )
}

/** The project's approvals as review cards, polled once for the bell, its panel and the stack. A decision shows at
 *  once and is sent to the daemon; if the daemon refuses it, the card returns and the refusal is shown. */
function useReviews(projectId: string) {
  // Tagged with its project, so the previous project's approvals never show under this one (lib/notifications.ts).
  const { data, reload } = usePoll(async () => ({ projectId, approvals: await api.approvals(projectId) }), [projectId], 10_000)
  const [decisions, setDecisions] = useState<Decisions>({ projectId, byId: {} })
  const [refusal, setRefusal] = useState<{ projectId: string; message: string } | null>(null)
  const reviews = reviewsFor(data, projectId, decisions)

  const decide = async (id: string, decision: ReviewDecision) => {
    setRefusal(null)
    setDecisions((prev) => ({ projectId, byId: { ...(prev.projectId === projectId ? prev.byId : {}), [id]: decision } }))
    const result = await api.decide(projectId, id, decision === 'approved' ? 'approve' : 'deny')
    if (result.kind === 'error') {
      setDecisions((prev) => {
        if (prev.projectId !== projectId) return prev
        const byId = { ...prev.byId }
        delete byId[id]
        return { projectId, byId }
      })
      setRefusal({ projectId, message: result.error })
      return
    }
    reload()
  }

  return { reviews, pending: pendingCount(reviews), error: refusal?.projectId === projectId ? refusal.message : null, decide }
}

export function Layout() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  const { reviews, pending, error, decide } = useReviews(projectId)
  return (
    <div className="flex h-dvh overflow-hidden">
      <ProjectSidebar projectId={projectId} branch={branch} />
      <div className="flex min-w-0 flex-1 flex-col bg-semantic-1">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-semantic-1">
          <div className="flex h-full min-w-0 items-center">
            <TopbarProjectSwitcher projectId={projectId} />
            <EnvSwitcher projectId={projectId} branch={branch} />
          </div>
          <div className="flex h-full shrink-0 items-center">
            <ActivitiesButton />
            <NotificationsButton count={pending} />
            <div className="flex h-full items-center justify-center border-l border-border p-2">
              <AccountMenu />
            </div>
          </div>
        </header>
        <div className="relative flex min-h-0 flex-1">
          <ReviewNotificationStack key={projectId} reviews={reviews} error={error} onDecide={decide} />
          <main className="relative min-w-0 flex-1 overflow-y-auto px-8 pt-8 pb-6">
            {/* Screens cap at 1620px on wide monitors, as on the console. */}
            <div className="mx-auto flex min-h-full w-full max-w-[1620px] flex-col">
              <Outlet />
            </div>
          </main>
          <ActivitiesPanel projectId={projectId} />
          <NotificationsPanel reviews={reviews} error={error} onDecide={decide} />
        </div>
      </div>
      <ProjectSettingsPanel projectId={projectId} />
    </div>
  )
}
