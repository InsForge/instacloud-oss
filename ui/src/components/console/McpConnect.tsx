// The "connect your agent over MCP" section of Quick Start. The daemon serves MCP over Streamable
// HTTP at <apiUrl>/mcp; this shows the endpoint, the token step (server mode only), ready-to-paste
// config for Claude Code and mcp.json clients, and a live "Test connection" that POSTs a tools/list
// to the SAME-ORIGIN /mcp (so it works with the logged-in session and never trips CORS to the api
// subdomain). All the copy/config strings come from lib/mcpConnect.ts (pure, tested).

import { useState } from 'react'
import { Button, cn } from '@insforge/ui'
import { Check, Copy, Plug } from 'lucide-react'
import { Link } from 'react-router-dom'
import { copyText } from '../../lib/clipboard'
import { claudeCodeAdd, mcpConnectPrompt, mcpEndpoint, mcpJsonConfig, MCP_TOOL_GROUPS } from '../../lib/mcpConnect'
import type { RunMode } from '../../lib/mode'

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-stretch overflow-hidden rounded-lg border border-border bg-card">
      <pre className="min-w-0 flex-1 overflow-x-auto px-3 py-2.5 font-mono text-[13px] leading-5 whitespace-pre">{text}</pre>
      <Button variant="ghost" size="icon" aria-label={copied ? `${label} copied` : `Copy ${label}`} title={copied ? 'Copied' : `Copy ${label}`}
        className="h-auto shrink-0 rounded-none border-l border-border px-3"
        onClick={async () => { if (await copyText(text)) { setCopied(true); setTimeout(() => setCopied(false), 2000) } }}>
        {copied ? <Check className="size-4 text-theme" /> : <Copy className="size-4 text-muted-foreground" />}
      </Button>
    </div>
  )
}

const CLIENTS = [{ id: 'claude', label: 'Claude Code' }, { id: 'json', label: 'mcp.json (Cursor, others)' }] as const
type ClientId = (typeof CLIENTS)[number]['id']

type TestState = { kind: 'idle' } | { kind: 'running' } | { kind: 'ok'; tools: number } | { kind: 'error'; message: string }

export function McpConnect({ mode, apiUrl, consoleUrl }: { mode: RunMode; apiUrl: string; consoleUrl: string }) {
  const [client, setClient] = useState<ClientId>('claude')
  const [test, setTest] = useState<TestState>({ kind: 'idle' })
  const endpoint = mcpEndpoint(apiUrl)
  const config = client === 'claude' ? claudeCodeAdd(apiUrl, mode) : mcpJsonConfig(apiUrl, mode)

  const runTest = async () => {
    setTest({ kind: 'running' })
    try {
      // Same-origin /mcp: the console SPA and the API share this daemon, so a relative POST carries
      // the session cookie and needs no CORS. This proves the endpoint an agent would use is live.
      const res = await fetch('/mcp', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
      if (!res.ok) { setTest({ kind: 'error', message: `daemon answered ${res.status}` }); return }
      const body = await res.json() as { result?: { tools?: unknown[] }; error?: { message?: string } }
      if (body.error) { setTest({ kind: 'error', message: body.error.message ?? 'error' }); return }
      setTest({ kind: 'ok', tools: body.result?.tools?.length ?? 0 })
    } catch (e) {
      setTest({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <section className="flex w-full max-w-[760px] flex-col gap-4 rounded-xl border border-border bg-semantic-1 p-5">
      <div className="flex items-center gap-2">
        <Plug className="size-5 text-theme" />
        <h2 className="text-base leading-7 font-medium">Connect an agent over MCP</h2>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">
        Your agent (Claude Code, Cursor, and others) talks to this daemon over MCP &mdash; no local
        server to install. Point it at the endpoint below.
      </p>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Endpoint</span>
        <CopyBlock text={endpoint} label="endpoint" />
      </div>

      {mode === 'server' ? (
        <p className="text-sm leading-6 text-muted-foreground">
          The config sends your token from <code className="font-mono">$INSTA_API_TOKEN</code>.{' '}
          <Link to="/account/tokens" className="text-theme">Create an API token</Link>, then set that variable before running the command.
        </p>
      ) : (
        <p className="text-sm leading-6 text-muted-foreground">No token needed &mdash; the daemon trusts loopback in local mode.</p>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex h-8 w-fit overflow-hidden rounded-lg border border-border bg-alpha-4">
          {CLIENTS.map((c) => (
            <button key={c.id} type="button" onClick={() => setClient(c.id)}
              className={cn('cursor-pointer px-3 text-sm transition-colors', client === c.id ? 'bg-card font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {c.label}
            </button>
          ))}
        </div>
        <CopyBlock text={config} label={client === 'claude' ? 'command' : 'config'} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" onClick={() => { void runTest() }} disabled={test.kind === 'running'}>
          {test.kind === 'running' ? 'Testing…' : 'Test connection'}
        </Button>
        {test.kind === 'ok' && <span className="flex items-center gap-1.5 text-sm text-success"><Check className="size-4" />Connected — {test.tools} tools available</span>}
        {test.kind === 'error' && <span className="text-sm text-destructive">Failed: {test.message}</span>}
        <details className="ml-auto text-sm text-muted-foreground">
          <summary className="cursor-pointer select-none">Prompt for an agent</summary>
          <div className="mt-2 w-full"><CopyBlock text={mcpConnectPrompt(apiUrl, mode, consoleUrl)} label="prompt" /></div>
        </details>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border pt-3">
        {MCP_TOOL_GROUPS.map((g) => (
          <span key={g.label} className="text-xs text-muted-foreground"><span className="text-foreground">{g.label}:</span> {g.tools.length} tools</span>
        ))}
      </div>
    </section>
  )
}
