// The attachment rows under a canvas card (insta-frontend services/service-attachments.tsx): today only a
// volume, "Volume" with its size, shown when the service carries one.
//
// Self-host divergences: nothing is staged, so the row is just the daemon's `volume_gib`; Postgres reports no
// volume size, so it has no row; and a row opens the Volume tab only where the detail has one (compute),
// since managed databases have no Volume tab here (lib/serviceTabs.ts).

import { tabsFor, type TabId } from './serviceTabs'

export interface Attachment {
  kind: 'volume'
  label: string
  /** The size, "10 GB". */
  meta: string
  /** The detail tab a click opens, or null to open the service on its default tab. */
  tab: TabId | null
}

export function attachmentsFor(service: { type: string; volume_gib?: number | null }): Attachment[] {
  const size = service.volume_gib
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return []
  return [{ kind: 'volume', label: 'Volume', meta: `${size} GB`, tab: tabsFor(service.type).includes('volume') ? 'volume' : null }]
}
