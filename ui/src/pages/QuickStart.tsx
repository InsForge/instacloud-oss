// The Quick Start page, ported from the console (insta-frontend app/projects/[id]/quick-start/page.tsx,
// components/project/quick-start/quick-start-page-view.tsx and quick-start-copy-chip.tsx): the agent
// connect pill with its CLI and Prompt copy chips, three cards deep-linking into the dialogs that do
// the work, and the docs link. The commands, prompt and cards, and every self-host divergence in
// them, live in lib/quickStart.ts. One divergence lives here: the pill gains a third "MCP" chip
// (see AgentConnectPill) because this daemon serves its own MCP endpoint that the console has no
// equivalent for; the config it copies is built in lib/mcpConnect.ts.

import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button, cn } from '@insforge/ui'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { useAuth } from '../components/AuthGate'
import { copyText } from '../lib/clipboard'
import { cliLine, DOCS_URL, quickStartCards, setupPrompt, type QuickStartCard } from '../lib/quickStart'
import { mcpJsonConfig, MCP_TOKEN_PLACEHOLDER } from '../lib/mcpConnect'

const ASSET = '/quick-start/'

/** One pill segment that copies. Through `copyText`, which falls back to execCommand where the page has no
 *  Clipboard API (a self-hosted dashboard on plain HTTP), and shows "Copied" only when the copy took. */
function CopyChip({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <Button variant="ghost" type="button"
      aria-label={copied ? `${label} copied` : `Copy ${label}: ${text}`}
      title={copied ? 'Copied' : `Copy ${label}`}
      className={cn(
        'h-full gap-1 px-2 text-base leading-6 font-normal text-foreground transition-colors hover:bg-alpha-8 focus-visible:bg-alpha-8 focus-visible:ring-inset motion-reduce:transition-none',
        label === 'CLI' ? 'w-[65px]' : label === 'MCP' ? 'w-[75px]' : 'w-[95px]',
        className,
      )}
      onClick={async () => { if (await copyText(text)) setCopied(true) }}>
      <span>{label}</span>
      {copied
        ? <Check className="size-5 shrink-0 text-theme" aria-hidden="true" />
        : <Copy className="size-5 shrink-0 text-disabled" aria-hidden="true" />}
    </Button>
  )
}

function MaskedArt({ src, className }: { src: string; className: string }) {
  const mask = `url(${ASSET}${src})`
  return (
    <span className={className} style={{
      WebkitMaskImage: mask, maskImage: mask, WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
      WebkitMaskPosition: 'center', maskPosition: 'center', WebkitMaskSize: 'contain', maskSize: 'contain',
    }} />
  )
}

// Divergence from the console: the console's pill has only CLI and Prompt chips (its MCP is a cloud
// server that `insta setup agent` registers, external to any one project). This daemon serves its own
// MCP over Streamable HTTP at <apiUrl>/mcp, so the local-honest equivalent is a third chip, built from
// the console's own CopyChip so it reads as native. It copies an mcp.json block that Claude Code,
// Cursor and other clients accept; the token step (server mode) is the same line the CLI chip needs.
function AgentConnectPill({ cli, prompt, mcp }: { cli: string; prompt: string; mcp: string }) {
  return (
    <div className="flex max-w-full flex-wrap items-center justify-center gap-3 rounded-full border border-semantic-6 bg-card px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <div className="flex shrink-0 items-center gap-2" aria-hidden="true">
          <MaskedArt src="openai.svg" className="size-5 bg-foreground" />
          {['claude-code-color.svg', 'gemini-color.svg', 'cursor-color.svg'].map((src) => (
            <img key={src} src={`${ASSET}${src}`} alt="" className="size-5 shrink-0" aria-hidden="true" />
          ))}
        </div>
        <span className="text-base leading-6 text-foreground">Connect your agent with</span>
      </div>
      <div className="flex h-8 shrink-0 overflow-hidden rounded-full border border-border bg-alpha-4">
        <CopyChip text={cli} label="CLI" className="border-r border-border" />
        <CopyChip text={prompt} label="Prompt" className="border-r border-border" />
        <CopyChip text={mcp} label="MCP" />
      </div>
    </div>
  )
}

const hoverSwap = 'transition-opacity motion-reduce:transition-none'

function CardGridArt({ kind }: { kind: QuickStartCard['kind'] }) {
  return (
    <div aria-hidden className="relative h-60 w-full shrink-0 overflow-hidden bg-page"
      style={{
        backgroundImage: 'linear-gradient(to right, var(--alpha-4) 1px, transparent 1px), linear-gradient(to bottom, var(--alpha-4) 1px, transparent 1px)',
        backgroundSize: '32px 32px',
        backgroundPosition: 'center',
      }}>
      {kind === 'database' && (
        <div className="absolute top-1/2 left-1/2 size-32 -translate-x-1/2 -translate-y-1/2">
          <MaskedArt src="postgres-muted.svg" className={cn('absolute inset-0 size-full bg-foreground group-hover:opacity-0 group-focus-visible:opacity-0', hoverSwap)} />
          <img src={`${ASSET}postgres-color.svg`} alt="" className={cn('absolute inset-0 size-full opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100', hoverSwap)} />
        </div>
      )}
      {kind === 'service' && (
        // The console's 2x2 of sources has GitHub in it; the daemon has no GitHub deploy.
        <div className="absolute top-1/2 left-1/2 grid -translate-x-1/2 -translate-y-1/2 grid-cols-3 gap-8">
          {['docker', 'database', 'storage'].map((name) => (
            <span key={name} className="relative flex size-16 items-center justify-center border border-border bg-alpha-4 transition-colors group-hover:bg-card group-focus-visible:bg-card motion-reduce:transition-none">
              <MaskedArt src={`${name}-color.svg`} className="size-8 bg-alpha-16 transition-colors group-hover:bg-foreground group-focus-visible:bg-foreground motion-reduce:transition-none" />
            </span>
          ))}
        </div>
      )}
      {kind === 'agent' && (
        <div className="absolute top-1/2 left-1/2 h-24 w-[152px] -translate-x-1/2 -translate-y-1/2">
          <MaskedArt src="agent-muted.svg" className={cn('absolute inset-0 size-full bg-foreground group-hover:opacity-0 group-focus-visible:opacity-0', hoverSwap)} />
          <div className={cn('absolute inset-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100', hoverSwap)}>
            <span className="absolute top-[19px] left-[37px] h-5 w-[11px] bg-[rgb(var(--insforge-black))]" />
            <span className="absolute top-[19px] left-[103px] h-5 w-[11px] bg-[rgb(var(--insforge-black))]" />
            <img src={`${ASSET}agent-color.svg`} alt="" className="absolute inset-0 size-full" />
          </div>
        </div>
      )}
    </div>
  )
}

function Card({ card }: { card: QuickStartCard }) {
  return (
    <Link to={card.href}
      className="group flex h-full min-h-[402px] flex-col border border-border bg-card transition-colors hover:border-foreground focus-visible:border-foreground focus-visible:outline-none motion-reduce:transition-none">
      <CardGridArt kind={card.kind} />
      <div className="flex flex-1 flex-col gap-4 p-3">
        <div className="flex flex-1 flex-col gap-2">
          <h2 className="text-base leading-7 font-medium text-foreground">{card.title}</h2>
          <p className="text-sm leading-6 text-muted-foreground">{card.description}</p>
        </div>
        <span className="flex h-9 w-full shrink-0 items-center justify-center border border-border bg-semantic-1 px-3 text-center text-sm leading-5 font-medium text-foreground transition-colors group-hover:bg-theme group-hover:text-inverse group-focus-visible:bg-theme group-focus-visible:text-inverse motion-reduce:transition-none">
          {card.cta}
        </span>
      </div>
    </Link>
  )
}

export function QuickStart() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  const { boot } = useAuth()

  return (
    <div className="@container flex min-h-full w-full flex-1 flex-col items-center justify-center bg-semantic-1 py-8">
      <div className="flex w-full flex-col items-center gap-12 px-6 pb-20">
        <header className="flex w-full flex-col items-center gap-6 text-center">
          <h1 className="font-heading text-[32px] leading-12 font-semibold text-foreground">Quick Start</h1>
          <AgentConnectPill cli={cliLine(projectId, boot.mode, boot.apiUrl)}
            prompt={setupPrompt(projectId, boot.mode, boot.apiUrl, boot.consoleUrl)}
            mcp={mcpJsonConfig(boot.apiUrl, boot.mode)} />
          {boot.mode === 'server' && (
            <p className="text-sm leading-6 text-muted-foreground">
              Both need an API token: the CLI reads <code className="font-mono">$INSTA_API_TOKEN</code> from your shell;
              in the MCP config, replace <code className="font-mono">{MCP_TOKEN_PLACEHOLDER}</code> with it.{' '}
              <Link to="/account/tokens" className="text-theme">Create one</Link>
            </p>
          )}
        </header>
        <ul className="grid w-full max-w-[1080px] grid-cols-1 gap-6 @3xl:grid-cols-3">
          {quickStartCards(projectId, branch).map((card) => (
            <li key={card.title}><Card card={card} /></li>
          ))}
        </ul>
        <a href={DOCS_URL} target="_blank" rel="noreferrer"
          className="flex items-center gap-1 text-center text-sm leading-6 text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-theme">
          <span>Need guides and reference for self-hosting InstaCloud? <span className="text-theme">Read Docs</span></span>
          <ExternalLink className="size-5 shrink-0 text-theme" aria-hidden="true" />
        </a>
      </div>
    </div>
  )
}
