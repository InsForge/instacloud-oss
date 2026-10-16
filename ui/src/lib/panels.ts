// The console's project popup panels are URL-driven (insta-frontend components/project/project-panels.tsx):
// `?panel=settings[&settings-tab=agent-governance]` on whatever page is open, so the sidebar trigger, deep links,
// refresh and the back button all work. Pure so the root vitest covers it.

export type SettingsTab = 'general' | 'agent-governance'

export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: string; icon: string }> = [
  { id: 'general', label: 'General', icon: 'general' },
  { id: 'agent-governance', label: 'Agent Governance', icon: 'governance' },
]

/** The tab a `settings-tab` value names; General for a missing or unknown one. */
export function settingsTabFrom(value: string | null): SettingsTab {
  return SETTINGS_TABS.find((tab) => tab.id === value)?.id ?? 'general'
}

function withQuery(params: URLSearchParams): string {
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

/** The current query with Settings open. Naming a `tab` switches to it (General carries no `settings-tab`, being
 *  the default); omitting it keeps whichever tab is already set, as the console's sidebar link does
 *  (project-sidebar.tsx sets `panel` and never touches `settings-tab`). Everything else in the query (an open
 *  `?service=` underneath) survives. */
export function withSettings(search: string, tab?: SettingsTab): string {
  const next = new URLSearchParams(search)
  next.set('panel', 'settings')
  if (tab === 'general') next.delete('settings-tab')
  else if (tab) next.set('settings-tab', tab)
  return withQuery(next)
}

/** The current query with any panel closed: its own params go, the rest survives. */
export function withoutPanel(search: string): string {
  const next = new URLSearchParams(search)
  next.delete('panel')
  next.delete('settings-tab')
  return withQuery(next)
}
