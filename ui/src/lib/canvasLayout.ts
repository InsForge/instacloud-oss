// The console's canvas constants and camera helpers (insta-frontend src/lib/canvas-layout.ts).
// Self-host divergence: a card grows by at most one attachment row, where the console allows two. The
// console's second row is PgBouncer, which the daemon has no equivalent of, so a volume is the only
// thing a card here can mount (lib/serviceAttachments.ts), and the tallest card is cardHeight(1).
//
// No react import: the root vitest config tests this module (see localPrefStore.ts on why).

import { readLocal, writeLocal } from './localPrefStore'
import type { Point } from './serviceGraph'

export const CARD_WIDTH = 320
/** The card's own body: a 100px header over a 40px footer. */
export const CARD_HEIGHT = 140
/** How much taller a card draws per attachment: a 36px row on the stack's 4px rhythm. */
const ATTACHMENT_ROW = 40
/** The stack adds a 1px rule and its 4px top pad above the rows themselves. */
export const cardHeight = (rows: number) => CARD_HEIGHT + (rows > 0 ? 5 + ATTACHMENT_ROW * rows : 0)
/** The tallest a card gets: what a packed block and the fit have to clear. */
export const CARD_MAX_HEIGHT = cardHeight(1)
/** What the hover row of "+ Add" slots occupies below a card: an 8px gap over a 32px button. The card's shell
 *  reserves it as padding while it offers slots, and a card offering one has no attachment row, so it stays
 *  within CARD_MAX_HEIGHT (140 + 40 = 180). */
export const ADD_ROW_SPACE = 40
export const LAYOUT_METRICS = {
  cardWidth: CARD_WIDTH,
  cardHeight: CARD_MAX_HEIGHT,
  gap: 60,
  edgeGap: 160,
  // Measured on the console: <main> less the sidebar and header is ~1.44 on a 1440x900 laptop and
  // ~1.65 at 1920x1080, so 3:2 sits inside the range where 16:9 sat outside it.
  aspect: 3 / 2,
}
/** Where an edge meets a card, measured from its top: the middle of the card BODY, not of the whole card,
 *  so the port holds still when an attachment row grows beneath it. */
export const PORT_Y = CARD_HEIGHT / 2
/**
 * How far an exit or entry point may slide along a card's edge as edges fan out. Short
 * of the port's own distance from the edge, so the arrowhead stays on the card's face.
 */
export const FAN_MAX = PORT_Y - 12
/** Dash, gap. */
export const WIRE_DASH = '6 5'
const MIN_SCALE = 0.25
const MAX_SCALE = 2
export const FIT_PADDING = 48
/**
 * How far past the fit ceiling the camera steps when pointing at named cards (`?focus=`); fitView's
 * default cap is 1 — an overview must not blow cards up.
 */
export const FOCUS_SCALE = 1.5
export const DOT_SPACING = 24
/** Pointer travel below this is a click (open the service), above it a drag. */
export const DRAG_THRESHOLD = 4

export interface Camera {
  x: number
  y: number
  scale: number
}

export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

/**
 * Whether the camera should follow the layout this pass, and whether it should glide.
 *
 * `claimed` covers every deliberate placement — a pan, a drag, a zoom, and a focus alike —
 * so a layout change that arrives afterwards (the bindings, a poll) never glides the camera
 * away from where the user put it. `fitted` is the layout the camera was last put on:
 * comparing signatures rather than object identity is what keeps a re-render, which rebuilds
 * the layout from a fresh services array without moving anything, from re-fitting.
 */
export function autoFit(claimed: boolean, fitted: string | null, signature: string): { fit: boolean; animate: boolean } {
  return { fit: !claimed && fitted !== signature, animate: fitted !== null }
}

/** Dragged cards snap to the dot lattice, so moves feel snappy and drops line up with the background. */
export const snapToGrid = (v: number) => Math.round(v / DOT_SPACING) * DOT_SPACING

/** Dragged card positions, per environment, keyed by service id. The console's key shape. */
export function positionsKey(projectId: string, branch: string): string {
  return `insta-canvas:${projectId}:${branch}`
}

export function loadPositions(key: string): Record<string, Point> {
  try {
    const raw = readLocal(key)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, Point> = {}
    for (const [id, p] of Object.entries(parsed as Record<string, unknown>)) {
      // Finite, not just numbers: JSON.parse reads an overflowing literal (1e999) as Infinity, which
      // would put the card, and the camera fitted to it, nowhere.
      if (p && typeof p === 'object' && Number.isFinite((p as Point).x) && Number.isFinite((p as Point).y)) {
        out[id] = { x: (p as Point).x, y: (p as Point).y }
      }
    }
    return out
  } catch {
    return {}
  }
}

/** A blocked or full store keeps the layout for this page only: the positions just won't survive a reload. */
export function savePositions(key: string, next: Record<string, Point>): void {
  writeLocal(key, JSON.stringify(next))
}

export function clearPositions(key: string): void {
  writeLocal(key, null)
}
