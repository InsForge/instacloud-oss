import { useMemo } from 'react'
import { cn } from '@insforge/ui'
import { parseMarkdown, type Block, type Inline } from '../lib/markdown'

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.kind) {
          case 'text': return <span key={i}>{n.text}</span>
          case 'code': return <code key={i} className="rounded bg-semantic-1 px-1 py-0.5 font-mono text-[12px]">{n.text}</code>
          case 'strong': return <strong key={i} className="font-semibold text-foreground"><Inlines nodes={n.children} /></strong>
          case 'em': return <em key={i}><Inlines nodes={n.children} /></em>
          case 'link': return (
            <a key={i} href={n.href} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2 hover:opacity-80">
              <Inlines nodes={n.children} />
            </a>
          )
        }
      })}
    </>
  )
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading': {
      const cls = block.level === 1 ? 'text-lg font-semibold' : block.level === 2 ? 'text-base font-semibold' : 'text-sm font-semibold'
      const Tag = (`h${Math.min(block.level + 2, 6)}`) as 'h3' | 'h4' | 'h5' | 'h6'
      return <Tag className={cn('mt-4 text-foreground first:mt-0', cls)}><Inlines nodes={block.children} /></Tag>
    }
    case 'paragraph': return <p className="text-sm leading-6"><Inlines nodes={block.children} /></p>
    case 'code': return (
      <pre className="overflow-x-auto rounded-md border border-border bg-semantic-1 p-3 font-mono text-[12px] leading-5" data-lang={block.lang || undefined}>
        {block.text}
      </pre>
    )
    case 'quote': return <blockquote className="border-l-2 border-border pl-3 text-sm text-muted-foreground"><Inlines nodes={block.children} /></blockquote>
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <Tag className={cn('pl-5 text-sm leading-6', block.ordered ? 'list-decimal' : 'list-disc')}>
          {block.items.map((it, i) => <li key={i}><Inlines nodes={it} /></li>)}
        </Tag>
      )
    }
    case 'rule': return <hr className="border-border" />
  }
}

/** Hand-written Markdown renderer (no dependency): everything renders through React text nodes,
 *  so raw HTML in a README is displayed, never interpreted. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return (
    <div className={cn('flex flex-col gap-3 text-muted-foreground', className)}>
      {blocks.map((b, i) => <BlockView key={i} block={b} />)}
    </div>
  )
}
