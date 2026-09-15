import { describe, expect, it } from 'vitest'
import { clampHighlight, moveHighlight, pickerView, templateCategoryLabel } from './templatePicker'

const catalog = [
  { code: 'claude-code', name: 'Claude Code', tagline: 'Coding agent', category: 'ai-agent', tags: ['ai'] },
  { code: 'hermes', name: 'Hermes', tagline: 'Messaging agent', category: 'ai-agent', tags: ['ai'] },
  { code: 'n8n', name: 'n8n', tagline: 'Workflow automation', category: 'automation', tags: [] },
  { code: 'ollama', name: 'Ollama', tagline: 'Local models', category: 'llm', tags: [] },
  { code: 'misc', name: 'Misc', tagline: 'Something else', category: 'data-tools', tags: [] },
]

describe('templateCategoryLabel', () => {
  it("uses the console's labels, and capitalises anything else", () => {
    expect(templateCategoryLabel('ai-agent')).toBe('AI Agent')
    expect(templateCategoryLabel('llm')).toBe('LLM')
    expect(templateCategoryLabel('automation')).toBe('Automation')
    expect(templateCategoryLabel('data-tools')).toBe('Data tools')
  })
})

describe('pickerView', () => {
  it("lists the categories in the console's order, others after, with counts", () => {
    const v = pickerView(catalog, '', 'all')
    expect(v.categories.map((c) => c.key)).toEqual(['ai-agent', 'llm', 'automation', 'data-tools'])
    expect(v.categories.find((c) => c.key === 'ai-agent')?.count).toBe(2)
    expect(v.total).toBe(5)
    expect(v.results).toHaveLength(5)
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
