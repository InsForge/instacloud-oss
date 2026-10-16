// The console's connect-agent panel (insta-frontend components/connect-agent-card.tsx `ConnectAgentPanel`, placed by
// services/service-view.tsx on the Service page's empty state): coding-agent marks and a title, a Use Prompt / Use CLI
// toggle, and one copy row per line, numbered when the CLI takes more than one.
//
// Self-host divergences: the commands and prompt are lib/quickStart.ts's (install the CLI, point it at this daemon,
// link the project) rather than the console's prompt.md one-liner, which sets an agent up on the cloud; the agent marks
// are the Quick Start page's static set rather than a cycling brand logo (the dashboard carries no icon package); and
// copying goes through lib/clipboard.ts, which also works over plain HTTP.

import { useEffect, useState } from 'react'
import { Button, cn } from '@insforge/ui'
import { Check, Copy } from 'lucide-react'
import { copyText } from '../../lib/clipboard'
import { copyRowKey, isCopyConfirmed } from '../../lib/copyConfirm'

const ASSET = '/quick-start/'

const MODES = [
  { key: 'prompt', label: 'Use Prompt' },
  { key: 'cli', label: 'Use CLI' },
] as const
type Mode = (typeof MODES)[number]['key']

/** A row's copy button. It holds no state of its own: the panel says whether this row is the one that was copied
 *  (lib/copyConfirm.ts), so a Use CLI / Use Prompt switch cannot leave "Copied" on text that was never copied. */
function CopyRowButton({ text, label, copied, onCopied }: { text: string; label: string; copied: boolean; onCopied: () => void }) {
  return (
    <Button variant="secondary" size="sm" type="button" className="h-8 shrink-0 gap-1.5" aria-label={copied ? `${label} copied` : label}
      onClick={async () => { if (await copyText(text)) onCopied() }}>
      {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

function AgentMarks() {
  const mask = `url(${ASSET}openai.svg)`
  return (
    <span className="flex shrink-0 items-center gap-1.5" aria-hidden>
      <span className="size-5 bg-foreground" style={{
        WebkitMaskImage: mask, maskImage: mask, WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center', maskPosition: 'center', WebkitMaskSize: 'contain', maskSize: 'contain',
      }} />
      {['claude-code-color.svg', 'gemini-color.svg', 'cursor-color.svg'].map((src) => (
        <img key={src} src={`${ASSET}${src}`} alt="" className="size-5 shrink-0" />
      ))}
    </span>
  )
}

export function ConnectAgentPanel({ prompt, cli, title = 'Connect Your Coding Agent', leadWith = 'prompt', className }: {
  prompt: string
  /** One shell command per step: each gets its own copy row, never a multi-line paste. */
  cli: string[]
  title?: string
  leadWith?: Mode
  className?: string
}) {
  const [mode, setMode] = useState<Mode>(leadWith)
  const rows = mode === 'cli' ? cli : [prompt]
  // The key of the row that was copied, cleared after two seconds.
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  useEffect(() => {
    if (copiedKey === null) return
    const timer = setTimeout(() => setCopiedKey(null), 2000)
    return () => clearTimeout(timer)
  }, [copiedKey])
  return (
    <div className={cn('flex w-[592px] max-w-full flex-col gap-3 border border-border bg-card p-3 shadow-[0px_8px_6px_rgba(0,0,0,0.04)]', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <AgentMarks />
          <span className="text-base leading-7 font-medium text-foreground">{title}</span>
        </div>
        <div role="group" aria-label="Setup method" className="flex w-[200px] shrink-0 overflow-hidden rounded border border-border bg-alpha-4 text-sm leading-5">
          {MODES.map(({ key, label }) => (
            <button key={key} type="button" aria-pressed={mode === key} onClick={() => setMode(key)}
              className={cn('flex-1 px-3 py-1.5 text-center whitespace-nowrap transition-colors',
                mode === key ? 'bg-alpha-16 text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <div key={copyRowKey(mode, row)} className="flex items-center gap-2 border border-border bg-alpha-4 p-3">
            <p className="min-w-0 flex-1 truncate font-mono text-sm text-foreground" title={row}>
              {rows.length > 1 && <span className="text-muted-foreground select-none">{i + 1}. </span>}
              {row}
            </p>
            <CopyRowButton text={row} label={rows.length > 1 ? `Copy step ${i + 1}: ${row}` : `Copy: ${row}`}
              copied={isCopyConfirmed(copiedKey, mode, row)} onCopied={() => setCopiedKey(copyRowKey(mode, row))} />
          </div>
        ))}
      </div>
    </div>
  )
}
