// The device-login approval page (server mode only): where a signed-in admin finishes
// `insta login --device`. The CLI prints a short code and a link to here; the admin confirms the
// code matches and approves, which mints an `insta_` key for that CLI (it then shows up under
// Account > API Tokens, revocable like any other). Self-host equivalent of the cloud's device flow,
// which the daemon cannot do over a hosted IdP; see src/auth.ts (POST /device/approve).

import { useEffect, useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { Button } from '@insforge/ui'
import { Check, KeyRound, X } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../components/AuthGate'
import { AccountMenu } from '../components/console/AccountMenu'
import { InstaCloudMark } from '../components/console/BrandMark'

type Phase = 'idle' | 'working' | 'approved' | 'denied' | 'error'

export function DeviceApprove() {
  const auth = useAuth()
  const [params] = useSearchParams()
  const [code, setCode] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState('')

  // Prefill from the ?code= the CLI's link carries, so the common path is one click.
  useEffect(() => { const c = params.get('code'); if (c) setCode(c) }, [params])

  if (auth.mode !== 'server') return <Navigate to="/" replace />

  const act = async (kind: 'approve' | 'deny') => {
    const trimmed = code.trim()
    if (!trimmed) { setPhase('error'); setMessage('Enter the code shown in your terminal.'); return }
    setPhase('working'); setMessage('')
    const r = await (kind === 'approve' ? api.approveDevice(trimmed) : api.denyDevice(trimmed))
    if (r.kind === 'ok') {
      setPhase(kind === 'approve' ? 'approved' : 'denied')
      setMessage(kind === 'approve'
        ? 'Approved. Return to your terminal; the CLI is signing in now.'
        : 'Denied. That login request was rejected.')
      return
    }
    setPhase('error')
    setMessage(r.kind === 'error' ? r.error : 'Something went wrong.')
  }

  const done = phase === 'approved' || phase === 'denied'

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-semantic-1">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border">
        <Link to="/" title="Back to the dashboard" className="flex h-full items-center gap-2 px-3 text-sm transition-colors hover:bg-alpha-4">
          <InstaCloudMark className="h-[19px] w-6 text-foreground" />
          Dashboard
        </Link>
        <div className="flex items-center gap-2 px-2"><AccountMenu /></div>
      </header>
      <main className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto p-6">
        <div className="flex w-full max-w-[440px] flex-col gap-5 rounded-lg border border-border bg-card p-6">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <KeyRound className="size-5 text-theme" />
              <h1 className="text-lg font-semibold">Connect a device</h1>
            </div>
            <p className="text-sm leading-6 text-muted-foreground">
              A device running <code className="font-mono">insta login --device</code> is asking to sign in.
              Check the code below matches the one in your terminal, then approve to mint it an API key.
            </p>
          </div>

          {done ? (
            <div className={`flex items-center gap-2 rounded-md border p-3 text-sm ${phase === 'approved' ? 'border-theme/40 text-foreground' : 'border-border text-muted-foreground'}`}>
              {phase === 'approved' ? <Check className="size-4 text-theme" /> : <X className="size-4" />}
              {message}
            </div>
          ) : (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium text-muted-foreground">Code from your terminal</span>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="XXXX-XXXX"
                  autoComplete="off" autoCapitalize="characters" spellCheck={false}
                  className="rounded-md border border-border bg-background px-3 py-2 text-center font-mono text-lg tracking-widest uppercase focus-visible:border-theme focus-visible:outline-none"
                />
              </label>
              {phase === 'error' && <p className="text-sm text-destructive">{message}</p>}
              <div className="flex gap-2">
                <Button className="flex-1" onClick={() => void act('approve')} disabled={phase === 'working'}>
                  {phase === 'working' ? 'Working…' : 'Approve'}
                </Button>
                <Button variant="secondary" onClick={() => void act('deny')} disabled={phase === 'working'}>Deny</Button>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                Only approve a code you started yourself. The key it mints is listed under{' '}
                <Link to="/account/tokens" className="text-theme">API Tokens</Link> and can be revoked there.
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
