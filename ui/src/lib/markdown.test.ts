import { describe, expect, it } from 'vitest'
import { inlineText, parseMarkdown, safeHref } from './markdown'

describe('parseMarkdown blocks', () => {
  it('parses headings, paragraphs, rules and setext headings', () => {
    const b = parseMarkdown('# Title\n\nSome text\nthat wraps.\n\n---\n\nSub\n===\n\n## Two ##')
    expect(b.map((x) => x.kind)).toEqual(['heading', 'paragraph', 'rule', 'heading', 'heading'])
    expect(b[0]).toMatchObject({ kind: 'heading', level: 1 })
    expect(inlineText((b[1] as unknown as { children: never[] }).children)).toBe('Some text that wraps.')
    expect(b[3]).toMatchObject({ kind: 'heading', level: 1 })
    expect(b[4]).toMatchObject({ kind: 'heading', level: 2 })
    expect(inlineText((b[4] as unknown as { children: never[] }).children)).toBe('Two')
  })

  it('keeps fenced code verbatim with its language and never parses inside it', () => {
    const b = parseMarkdown('```bash\ninsta login --api-key **x**\n<b>raw</b>\n```\nafter')
    expect(b[0]).toEqual({ kind: 'code', lang: 'bash', text: 'insta login --api-key **x**\n<b>raw</b>' })
    expect(b[1]).toMatchObject({ kind: 'paragraph' })
  })

  it('parses unordered and ordered lists with continuation lines', () => {
    const b = parseMarkdown('- one\n- two\n  continued\n* three\n\n1. a\n2) b')
    expect(b).toHaveLength(2)
    expect(b[0]).toMatchObject({ kind: 'list', ordered: false })
    const items = (b[0] as unknown as { items: never[][] }).items.map((i) => inlineText(i))
    expect(items).toEqual(['one', 'two continued', 'three'])
    expect(b[1]).toMatchObject({ kind: 'list', ordered: true })
    expect((b[1] as unknown as { items: never[][] }).items.map((i) => inlineText(i))).toEqual(['a', 'b'])
  })

  it('parses block quotes', () => {
    const b = parseMarkdown('> quoted\n> line')
    expect(b[0]).toMatchObject({ kind: 'quote' })
    expect(inlineText((b[0] as unknown as { children: never[] }).children)).toBe('quoted line')
  })

  it('leaves raw HTML as text (never a node type the renderer would interpret)', () => {
    const b = parseMarkdown('<script>alert(1)</script> and <img src=x onerror=alert(1)>')
    expect(b).toHaveLength(1)
    expect(b[0].kind).toBe('paragraph')
    const p = b[0] as { children: Array<{ kind: string; text?: string }> }
    expect(p.children.every((c) => c.kind === 'text')).toBe(true)
    expect(inlineText(p.children as never)).toBe('<script>alert(1)</script> and <img src=x onerror=alert(1)>')
  })
})

describe('inline parsing', () => {
  const para = (s: string) => (parseMarkdown(s)[0] as { children: Array<Record<string, unknown>> }).children

  it('parses code, bold, italic and links', () => {
    const c = para('run `insta deploy` with **force** or _care_ at [docs](https://example.com/x "t")')
    expect(c.map((n) => n.kind)).toEqual(['text', 'code', 'text', 'strong', 'text', 'em', 'text', 'link'])
    expect(c[1]).toEqual({ kind: 'code', text: 'insta deploy' })
    expect(c[7]).toMatchObject({ kind: 'link', href: 'https://example.com/x' })
  })

  it('drops non-http link targets but keeps their text', () => {
    const c = para('[x](javascript:alert(1)) and [y](mailto:a@b.c)')
    expect(c.some((n) => n.kind === 'link')).toBe(false)
    expect(inlineText(c as never)).toBe('x and y')
  })

  it('auto-links bare URLs without trailing punctuation', () => {
    const c = para('see https://example.com/a.')
    expect(c[1]).toMatchObject({ kind: 'link', href: 'https://example.com/a' })
    expect(c[2]).toEqual({ kind: 'text', text: '.' })
  })

  it('renders images as their alt text', () => {
    expect(inlineText(para('![Deploy](https://x/y.svg) now') as never)).toBe('Deploy now')
  })

  it('does not treat snake_case as italics', () => {
    const c = para('ADMIN_PASSWORD and my_var_name')
    expect(c).toHaveLength(1)
    expect(c[0]).toEqual({ kind: 'text', text: 'ADMIN_PASSWORD and my_var_name' })
  })
})

describe('safeHref', () => {
  it('accepts http(s) and anchors, rejects the rest', () => {
    expect(safeHref('https://a.b')).toBe('https://a.b')
    expect(safeHref('HTTP://a.b')).toBe('HTTP://a.b')
    expect(safeHref('#section')).toBe('#section')
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('data:text/html,x')).toBeNull()
    expect(safeHref('/relative')).toBeNull()
  })
})
