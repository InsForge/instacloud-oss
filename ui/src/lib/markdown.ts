// Dependency-free Markdown subset for template READMEs: headings, paragraphs, fenced code, block
// quotes, unordered and ordered lists, inline code, bold, italic and http(s) links. The output is
// a tree of plain data the component renders through React text nodes, so raw HTML in the source
// is shown as text, never interpreted (plan 07 I: raw HTML escaped).

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'rule' }

/** Only http(s) (and same-page anchors) survive as clickable links; anything else renders as text. */
export function safeHref(href: string): string | null {
  const h = href.trim()
  if (/^https?:\/\//i.test(h)) return h
  if (h.startsWith('#')) return h
  return null
}

function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let text = ''
  const flush = () => { if (text) { out.push({ kind: 'text', text }); text = '' } }
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    // inline code: `...` (no nesting)
    if (ch === '`') {
      const end = src.indexOf('`', i + 1)
      if (end > i) { flush(); out.push({ kind: 'code', text: src.slice(i + 1, end) }); i = end + 1; continue }
    }
    // image ![alt](url): render the alt text (no remote images in a readme dialog)
    if (ch === '!' && src[i + 1] === '[') {
      const m = /^!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/.exec(src.slice(i))
      if (m) { text += m[1]; i += m[0].length; continue }
    }
    // link [text](url)
    if (ch === '[') {
      const m = /^\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/.exec(src.slice(i))
      if (m) {
        flush()
        const href = safeHref(m[2])
        const children = parseInline(m[1])
        if (href) out.push({ kind: 'link', href, children })
        else out.push(...children)
        i += m[0].length
        continue
      }
    }
    // bold **x** or __x__
    if ((ch === '*' && src[i + 1] === '*') || (ch === '_' && src[i + 1] === '_')) {
      const mark = src.slice(i, i + 2)
      const end = src.indexOf(mark, i + 2)
      if (end > i + 2) { flush(); out.push({ kind: 'strong', children: parseInline(src.slice(i + 2, end)) }); i = end + 2; continue }
    }
    // italic *x* or _x_ (not inside a word for underscores)
    if ((ch === '*' || (ch === '_' && (i === 0 || /\s/.test(src[i - 1])))) && src[i + 1] && !/\s/.test(src[i + 1])) {
      const end = src.indexOf(ch, i + 1)
      if (end > i + 1 && (ch === '*' || end === src.length - 1 || /[\s.,;:!?)]/.test(src[end + 1]))) {
        flush(); out.push({ kind: 'em', children: parseInline(src.slice(i + 1, end)) }); i = end + 1; continue
      }
    }
    // bare URL
    if (ch === 'h' && /^https?:\/\//.test(src.slice(i, i + 8))) {
      const m = /^https?:\/\/[^\s<>)]+/.exec(src.slice(i))
      if (m) {
        let url = m[0]
        while (/[.,;:!?]$/.test(url)) url = url.slice(0, -1)
        flush(); out.push({ kind: 'link', href: url, children: [{ kind: 'text', text: url }] }); i += url.length; continue
      }
    }
    text += ch
    i++
  }
  flush()
  return out
}

/** Parse a Markdown document into blocks. Never throws; unknown constructs become paragraphs. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flushPara = () => {
    if (!para.length) return
    blocks.push({ kind: 'paragraph', children: parseInline(para.join(' ').trim()) })
    para = []
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = /^\s*(```|~~~)\s*([\w.+-]*)\s*$/.exec(line)
    if (fence) {
      flushPara()
      const close = fence[1]
      const body: string[] = []
      i++
      while (i < lines.length && !new RegExp(`^\\s*${close}\\s*$`).test(lines[i])) { body.push(lines[i]); i++ }
      i++ // closing fence (or end of input)
      blocks.push({ kind: 'code', lang: fence[2] ?? '', text: body.join('\n') })
      continue
    }
    if (/^\s*$/.test(line)) { flushPara(); i++; continue }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      flushPara()
      blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, children: parseInline(heading[2]) })
      i++
      continue
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); blocks.push({ kind: 'rule' }); i++; continue }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      flushPara()
      const parts = [quote[1]]
      i++
      while (i < lines.length) {
        const q = /^\s*>\s?(.*)$/.exec(lines[i])
        if (!q) break
        parts.push(q[1]); i++
      }
      blocks.push({ kind: 'quote', children: parseInline(parts.join(' ').trim()) })
      continue
    }
    const bullet = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (bullet) {
      flushPara()
      const ordered = /\d/.test(bullet[1])
      const items: Inline[][] = []
      let cur = bullet[2]
      i++
      while (i < lines.length) {
        const next = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
        if (next && /\d/.test(next[1]) === ordered) { items.push(parseInline(cur.trim())); cur = next[2]; i++; continue }
        // continuation line (indented, non-blank) folds into the current item
        if (/^\s+\S/.test(lines[i]) && !/^\s*(```|~~~)/.test(lines[i])) { cur += ' ' + lines[i].trim(); i++; continue }
        break
      }
      items.push(parseInline(cur.trim()))
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    // Setext headings: a line followed by === or ---
    if (i + 1 < lines.length && /^\s*(={3,}|-{3,})\s*$/.test(lines[i + 1]) && para.length === 0 && line.trim()) {
      blocks.push({ kind: 'heading', level: lines[i + 1].trim().startsWith('=') ? 1 : 2, children: parseInline(line.trim()) })
      i += 2
      continue
    }
    para.push(line)
    i++
  }
  flushPara()
  return blocks
}

/** Plain text of an inline run (for titles and tests). */
export function inlineText(nodes: Inline[]): string {
  return nodes.map((n) => (n.kind === 'text' || n.kind === 'code' ? n.text : inlineText(n.children))).join('')
}
