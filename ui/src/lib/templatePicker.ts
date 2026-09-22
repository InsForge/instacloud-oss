// The Deploy a Template picker's view (insta-frontend console/templates/template-picker.tsx, template-category-rail.tsx,
// lib/api/templates.ts `categoryLabel`, `TEMPLATE_CATEGORIES`). Pure so the root vitest covers it.
//
// Two reductions in the console's order: the search first, then the category, so the rail counts what the SEARCH
// found rather than what the catalog holds. The active category stays on the rail even when the search left it with
// nothing, so a filter that is still applied never disappears from the screen.

import { ALL_CATEGORIES, filterTemplates, type CatalogItem } from './catalog'

/** The console's category order. A category it does not know follows, alphabetically. */
export const TEMPLATE_CATEGORY_ORDER = ['ai-agent', 'llm', 'automation'] as const

const LABELS: Record<string, string> = { 'ai-agent': 'AI Agent', llm: 'LLM', automation: 'Automation' }

/** "AI Agent", "LLM", "Automation"; any other category reads as its words, first letter capitalised. */
export function templateCategoryLabel(category: string): string {
  if (LABELS[category]) return LABELS[category]
  const words = category.replace(/-/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : category
}

export interface PickerCategory { key: string; label: string; count: number }

export interface PickerView<T> {
  /** What the search matched, in every category. */
  byQuery: T[]
  /** What the list shows: the search, narrowed to the active category. */
  results: T[]
  categories: PickerCategory[]
  total: number
}

export function pickerView<T extends CatalogItem>(items: readonly T[], query: string, active: string): PickerView<T> {
  const byQuery = filterTemplates([...items], query)
  const present = new Set(byQuery.map((t) => t.category ?? '').filter(Boolean))
  if (active !== ALL_CATEGORIES) present.add(active)
  const order = TEMPLATE_CATEGORY_ORDER as readonly string[]
  const keys = [...order.filter((c) => present.has(c)), ...[...present].filter((c) => !order.includes(c)).sort()]
  const categories = keys.map((key) => ({
    key, label: templateCategoryLabel(key), count: byQuery.filter((t) => t.category === key).length,
  }))
  const results = active === ALL_CATEGORIES ? byQuery : byQuery.filter((t) => t.category === active)
  return { byQuery, results, categories, total: byQuery.length }
}

/** Typing re-filters, so the highlight is clamped to the list rather than remembered past its end. */
export function clampHighlight(highlight: number, length: number): number {
  return Math.min(Math.max(highlight, 0), Math.max(length - 1, 0))
}

/** ↑/↓ wrap around the list. */
export function moveHighlight(active: number, delta: number, length: number): number {
  return length === 0 ? 0 : (active + delta + length) % length
}
