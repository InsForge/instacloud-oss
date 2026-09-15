// The Volume tab's size rules (insta-frontend lib/volume-size.ts, volumes/volume-card.tsx `floor`/`max`/`atPlanCeiling`,
// lib/format.ts `formatVolumeGib`). Pure so the root vitest covers it.
//
// Self-host divergence: there is no plan, so the cap is the daemon's one fixed ceiling and "at the ceiling" means that
// ceiling rather than an upgrade prompt.

export const MIN_VOLUME_GIB = 1

export function formatVolumeGib(volumeGib: number): string {
  return `${volumeGib} GB`
}

export interface SizeBounds {
  /** Lowest selectable size: the disk's own once it exists (grow-only), the minimum before that. */
  floor: number
  /** Highest selectable size: the cap, or the disk's size when it already sits above it. */
  max: number
  /** An attached disk with no room left to grow into. */
  atCeiling: boolean
}

export function sizeBounds(attached: { sizeGib: number } | null, cap: number): SizeBounds {
  const floor = attached ? attached.sizeGib : MIN_VOLUME_GIB
  const max = Math.max(cap, attached?.sizeGib ?? 0)
  return { floor, max, atCeiling: attached !== null && max <= attached.sizeGib }
}

/** Why `text` is not a size the daemon would take, or null when it is. */
export function sizeError(text: string, { floor, max }: SizeBounds): string | null {
  const n = Number(text.trim())
  if (!text.trim() || !Number.isInteger(n)) return 'Enter a whole number of GB.'
  if (n < floor) return floor > MIN_VOLUME_GIB ? `A volume can only grow: ${formatVolumeGib(floor)} or more.` : `At least ${formatVolumeGib(floor)}.`
  if (n > max) return `At most ${formatVolumeGib(max)}.`
  return null
}
