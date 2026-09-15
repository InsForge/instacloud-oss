// The console's project switcher (insta-frontend components/project/project-switcher.tsx): the
// sidebar header is two hit areas, the logo cell (back to all projects) and the name + chevron
// (the project dropdown). With the rail collapsed the dropdown moves into the topbar as a 240px
// cell. Self-host divergence: there is no projects gallery or in-app project create (a project is
// made with `insta project create`), so the menu lists projects only.

import { useEffect, useReducer, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@insforge/ui'
import { Check, ChevronDown } from 'lucide-react'
import { api } from '../../api'
import { InstaCloudMark } from './BrandMark'
import { useSidebarCollapsed } from './AppSidebar'

/** ONE poll of the project list for the whole shell.
 *
 *  Three components need the same list: the sidebar switcher, the menu nested inside it, and the
 *  collapsed-rail stand-in in the topbar. Each called its own `usePoll`, so the shell issued three
 *  identical requests every 30 seconds, and the topbar one ran even while the rail was expanded
 *  and it rendered nothing. A module-level cache with one in-flight request and a subscriber set
 *  keeps every caller in step without pulling in a data layer. */
let cache: Awaited<ReturnType<typeof api.projects>> | undefined
let nextFetchAt = 0
let inflight: Promise<void> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()
const PROJECTS_TTL = 30_000
/** A FAILED fetch is not worth the full TTL. It used to take one — the catch advanced the same
 *  clock a success did — so a single transient failure at load left both switchers blank for 30
 *  seconds with nothing to retry them, and the very first paint is exactly when a daemon that is
 *  still coming up returns one. Short enough to recover from a blip, long enough not to hammer a
 *  daemon that is genuinely down. */
const RETRY_AFTER_ERROR = 3_000

function refreshProjects(): void {
  if (inflight || Date.now() < nextFetchAt) return
  inflight = api.projects()
    .then((list) => { cache = list; nextFetchAt = Date.now() + PROJECTS_TTL; listeners.forEach((l) => { l() }) })
    .catch(() => {
      nextFetchAt = Date.now() + RETRY_AFTER_ERROR
      // The interval only comes round every TTL, so the short backoff needs something to act on
      // it. One timer at a time, and only while something is actually mounted to receive it.
      if (listeners.size && !retryTimer) {
        retryTimer = setTimeout(() => { retryTimer = null; refreshProjects() }, RETRY_AFTER_ERROR)
      }
    })
    .finally(() => { inflight = null })
}

function useProjects() {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    listeners.add(bump)
    refreshProjects()
    const id = setInterval(refreshProjects, PROJECTS_TTL)
    return () => {
      listeners.delete(bump)
      clearInterval(id)
      // The last subscriber leaving takes the pending retry with it: nothing is listening for the
      // result, and a timer left running holds a fetch against a shell that is gone.
      if (!listeners.size && retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    }
  }, [])
  return cache
}

/** After a rename or a delete: fetch the list now rather than waiting out the TTL. A fetch already in flight
 *  may have started before the change, so a second one follows it. */
export function refreshProjectsNow(): void {
  nextFetchAt = 0
  if (inflight) void inflight.then(() => { nextFetchAt = 0; refreshProjects() })
  else refreshProjects()
}

/** This project's display name from the shell's one project list; undefined until the list loads. */
export function useProjectName(projectId: string): string | undefined {
  return useProjects()?.find((project) => project.id === projectId)?.name
}

function ProjectSwitcherMenu({ projectId, trigger }: { projectId: string; trigger: ReactNode }) {
  const nav = useNavigate()
  const projects = useProjects() ?? []
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <div className="max-h-78 overflow-y-auto">
          {projects.map((project) => {
            const current = project.id === projectId
            return (
              <DropdownMenuItem key={project.id} onSelect={() => { if (!current) nav(`/p/${project.id}`) }}>
                <Check className={current ? 'size-4 shrink-0' : 'invisible size-4 shrink-0'} />
                <span className="truncate">{project.name}</span>
              </DropdownMenuItem>
            )
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ProjectSwitcher({ projectId }: { projectId: string }) {
  const [collapsed] = useSidebarCollapsed()
  const name = useProjects()?.find((p) => p.id === projectId)?.name ?? ''
  return (
    <div className="flex h-12 w-60 shrink-0 items-center border-b border-border transition-colors has-[[data-state=open]]:bg-alpha-8 has-[button:hover]:bg-alpha-4">
      <Link to="/" title="All Projects" aria-label="All Projects"
        className="group/logo flex h-full w-12 shrink-0 items-center justify-center outline-hidden">
        <span className="flex size-8 items-center justify-center transition-colors group-hover/logo:bg-alpha-8 group-focus-visible/logo:bg-alpha-8">
          <InstaCloudMark className="h-[19px] w-6 text-foreground" />
        </span>
      </Link>
      <ProjectSwitcherMenu
        projectId={projectId}
        trigger={
          // Collapsed it is invisible and click-through, but it stayed in the tab order, so a
          // keyboard user hit an unseeable trigger before reaching the visible topbar one.
          <button type="button" tabIndex={collapsed ? -1 : undefined} aria-hidden={collapsed || undefined}
            className={cn('flex h-full min-w-0 flex-1 items-center text-left outline-hidden transition-colors focus-visible:bg-alpha-8',
              collapsed && 'pointer-events-none')}>
            <span className={cn('min-w-0 flex-1 truncate text-sm transition-opacity duration-200', collapsed && 'opacity-0')}>{name}</span>
            <ChevronDown className={cn('mr-3 size-4 shrink-0 text-muted-foreground transition-opacity duration-200', collapsed && 'opacity-0')} />
          </button>
        }
      />
    </div>
  )
}

/** The collapsed-rail stand-in: renders nothing while the sidebar is expanded. */
export function TopbarProjectSwitcher({ projectId }: { projectId: string }) {
  const [collapsed] = useSidebarCollapsed()
  const name = useProjects()?.find((p) => p.id === projectId)?.name ?? ''
  if (!collapsed) return null
  return (
    <ProjectSwitcherMenu
      projectId={projectId}
      trigger={
        <button type="button"
          className="flex h-full w-60 shrink-0 items-center gap-2 border-r border-border px-3 text-left outline-hidden transition-colors hover:bg-alpha-4 focus-visible:bg-alpha-8 data-[state=open]:bg-alpha-8">
          <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
          <ChevronDown className="size-5 shrink-0 text-muted-foreground" />
        </button>
      }
    />
  )
}
