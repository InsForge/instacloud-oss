// The console's date and time formatting (insta-frontend lib/format.ts), pure so the root vitest covers it.

const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
})

/** "Sep 14, 2026, 9:19 PM UTC", as the console's Branches table reads; "—" for a missing or unreadable time. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return `${dateTimeFormat.format(date)} UTC`
}
