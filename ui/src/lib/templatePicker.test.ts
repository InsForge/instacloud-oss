import { describe, expect, it } from 'vitest'
import { clampHighlight, moveHighlight, pickerView, templateCategoryLabel } from './templatePicker'

const catalog = [
  { code: 'claude-code', name: 'Claude Code', tagline: 'Coding agent', category: 'ai-agent', tags: ['ai'] },
  { code: 'hermes', name: 'Hermes', tagline: 'Messaging agent', category: 'ai-agent', tags: ['ai'] },
  { code: 'n8n', name: 'n8n', tagline: 'Workflow automation', category: 'automation', tags: [] },
  { code: 'ollama', name: 'Ollama', tagline: 'Local models', category: 'llm', tags: [] },
  { code: 'supabase', name: 'Supabase', tagline: 'One backend', category: 'backend', tags: [] },
  { code: 'clickhouse', name: 'ClickHouse', tagline: 'Analytics database', category: 'database', tags: [] },
  { code: 'misc', name: 'Misc', tagline: 'Something else', category: 'data-tools', tags: [] },
]

describe('templateCategoryLabel', () => {
  it("uses the console's labels, and capitalises anything else", () => {
    expect(templateCategoryLabel('ai-agent')).toBe('AI Agent')
    expect(templateCategoryLabel('llm')).toBe('LLM')
    expect(templateCategoryLabel('automation')).toBe('Automation')
    expect(templateCategoryLabel('backend')).toBe('Backend')
    expect(templateCategoryLabel('database')).toBe('Database')
    expect(templateCategoryLabel('data-tools')).toBe('Data tools')
  })
})

describe('pickerView', () => {
  it("lists the categories in the console's order, others after, with counts", () => {
    const v = pickerView(catalog, '', 'all')
    // backend and database are in TEMPLATE_CATEGORY_ORDER, so they come before data-tools, which is
    // not. Without them on that list both would sort in with data-tools and database would follow it.
    expect(v.categories.map((c) => c.key)).toEqual(['ai-agent', 'llm', 'automation', 'backend', 'database', 'data-tools'])
    expect(v.categories.find((c) => c.key === 'ai-agent')?.count).toBe(2)
    expect(v.total).toBe(7)
    expect(v.results).toHaveLength(7)
  })
  it('counts what the search found, and drops categories it left empty', () => {
    const v = pickerView(catalog, 'agent', 'all')
    expect(v.total).toBe(2)
    expect(v.categories.map((c) => [c.key, c.count])).toEqual([['ai-agent', 2]])
  })
  it('narrows to the active category, and keeps that category listed when the search empties it', () => {
    expect(pickerView(catalog, '', 'llm').results.map((t) => t.code)).toEqual(['ollama'])
    const v = pickerView(catalog, 'agent', 'llm')
    expect(v.results).toEqual([])
    expect(v.byQuery).toHaveLength(2)
    expect(v.categories.map((c) => [c.key, c.count])).toEqual([['ai-agent', 2], ['llm', 0]])
  })
})

describe('highlight', () => {
  it('clamps to the list and wraps on arrows', () => {
    expect(clampHighlight(4, 2)).toBe(1)
    expect(clampHighlight(3, 0)).toBe(0)
    expect(moveHighlight(1, 1, 2)).toBe(0)
    expect(moveHighlight(0, -1, 3)).toBe(2)
    expect(moveHighlight(0, 1, 0)).toBe(0)
  })
})
