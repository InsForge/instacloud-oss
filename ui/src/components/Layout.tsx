// The project shell, ported from the console (insta-frontend app/projects/[id]/layout.tsx,
// project-sidebar.tsx, project-topbar.tsx): a fixed viewport where only <main> scrolls; the
// collapsible sidebar with the project switcher at its head; a 48px topbar with the branch switcher
// on the left and the Activities and account cells on the right; and the Activities panel docked to
// the right of the content, pushing it aside rather than covering it.
//
// Sidebar, as the console orders it: Service, Observability, Secrets | Branches | Quick Start,
// Settings. Self-host divergences: no Usage (billing) entry; Observability opens the live CPU/memory
// page. Logs and Database live in the service detail, as they do on the console.

import { Outlet, useLocation, useParams } from 'react-router-dom'
import { Activity, Box, Download, KeyRound, Settings, Settings2, type LucideIcon } from 'lucide-react'
import { AppSidebar, SidebarDivider, SidebarLink } from './console/AppSidebar'
import { ProjectSwitcher, TopbarProjectSwitcher } from './console/ProjectSwitcher'
import { EnvSwitcher } from './console/EnvSwitcher'
import { ActivitiesButton, ActivitiesPanel } from './console/ActivitiesButton'
import { AccountMenu } from './console/AccountMenu'
import { api } from '../api'
import { usePoll } from '../hooks'
import { pendingFor } from '../lib/activity'

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
  const { pathname } = useLocation()
  const base = `/p/${projectId}/${branch}`
  const item = ({ label, segment, icon }: NavItem) => {
    const to = `${base}/${segment}`
    const active = pathname === to || pathname.startsWith(`${to}/`)
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

export function Layout() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  // Polled once here and handed to both the Activities icon and its panel, rather than once by each.
  // Tagged with its project, so the previous project's queue never badges this one (lib/activity.ts).
  const { data: approvals } = usePoll(
    async () => ({ projectId, statuses: (await api.approvals(projectId)).map((a) => a.status) }),
    [projectId],
    10_000,
  )
  const pending = pendingFor(approvals, projectId)
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
            <ActivitiesButton pending={pending} />
            <div className="flex h-full items-center justify-center border-l border-border p-2">
              <AccountMenu />
            </div>
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <main className="relative min-w-0 flex-1 overflow-y-auto px-8 pt-8 pb-6">
            {/* Screens cap at 1620px on wide monitors, as on the console. */}
            <div className="mx-auto flex min-h-full w-full max-w-[1620px] flex-col">
              <Outlet />
            </div>
          </main>
          <ActivitiesPanel projectId={projectId} branch={branch} pending={pending} />
        </div>
      </div>
    </div>
  )
}
