// Account > API Tokens (server mode only): list, mint, revoke `insta_` keys, in the console's
// chrome (48px bar with the brand mark and the account menu, a title band, the console's table).
// Self-host divergence: the console has no token page (its CLI signs in with a device code); a
// self-hosted CLI signs in with one of these keys.

import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import {
  Button, ConfirmDialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@insforge/ui'
import { EllipsisVertical, KeyRound } from 'lucide-react'
import { api, relTime, type ApiToken } from '../api'
import { useAuth } from '../components/AuthGate'
import { TokenCreate } from '../components/TokenCreate'
import { ErrorNote } from '../components/ui'
import { AccountMenu } from '../components/console/AccountMenu'
import { InstaCloudMark } from '../components/console/BrandMark'
import { usePoll } from '../hooks'
import { apiUrlForCli } from '../lib/apiUrl'

function fmtDate(iso: string | null): string {
  if (!iso) return 'never'
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function Th({ children }: { children?: string }) {
  return <th className="px-4 py-3 text-left text-[13px] font-normal text-muted-foreground">{children}</th>
}

function AccountShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-semantic-1">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border">
        <Link to="/" title="Back to the dashboard" className="flex h-full items-center gap-2 px-3 text-sm transition-colors hover:bg-alpha-4">
          <InstaCloudMark className="h-[19px] w-6 text-foreground" />
          Dashboard
        </Link>
        <div className="flex items-center gap-2 px-2"><AccountMenu /></div>
      </header>
      <main className="min-w-0 flex-1 overflow-y-auto px-8 pt-8 pb-6">
        <div className="mx-auto flex w-full max-w-[1620px] flex-col">{children}</div>
      </main>
    </div>
  )
}

export function Tokens() {
  const auth = useAuth()
  const { data: tokens, error, reload } = usePoll(api.tokens, [], 30000)
  const [revoking, setRevoking] = useState<ApiToken | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()

  if (auth.mode !== 'server') return <Navigate to="/" replace />

  const rows = (tokens ?? []).filter((t) => !t.revokedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const apiUrl = auth.boot.apiUrl || apiUrlForCli(location.origin)

  const revoke = async () => {
    if (!revoking) return
    setBusy(true); setActionError(undefined)
    const r = await api.revokeToken(revoking.id)
    setBusy(false); setRevoking(null)
    if (r.kind === 'error') { if (r.status !== 404) return setActionError(r.error); setActionError('Already revoked.') }
    reload()
  }

  return (
    <AccountShell>
      <div className="-mx-8 -mt-8 flex w-auto flex-col gap-4">
        <div className="px-6">
          <div className="flex flex-col gap-1 py-4.5">
            <h1 className="text-[32px] leading-12 font-semibold">API Tokens</h1>
            <p className="text-[13px] text-muted-foreground">
              <code className="font-mono">insta_</code> keys for the CLI, MCP and agents. Revoking one breaks whatever uses it immediately.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-4 px-6">
          <div className="rounded-lg border border-border bg-card p-4">
            <TokenCreate apiUrl={apiUrl} defaultName="" showExpiry onCreated={reload} />
          </div>
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <Th>Name</Th>
                  <Th>Key</Th>
                  <Th>Created</Th>
                  <Th>Last Used</Th>
                  <Th>Expires</Th>
                  <th className="w-12" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                      <span className="inline-flex items-center gap-2"><KeyRound className="size-4" /> {error ? error.message : 'No tokens yet.'}</span>
                    </td>
                  </tr>
                ) : rows.map((t) => (
                  <tr key={t.id} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-3 text-sm">{t.name}</td>
                    <td className="px-4 py-3 font-mono text-[13px] text-muted-foreground">{t.prefix}{'•'.repeat(8)}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground" title={t.createdAt}>{fmtDate(t.createdAt)}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground" title={t.lastUsedAt ?? undefined}>{t.lastUsedAt ? relTime(t.lastUsedAt) : 'never'}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{fmtDate(t.expiresAt)}</td>
                    <td className="px-2 py-3 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${t.name}`}>
                            <EllipsisVertical className="size-4 text-muted-foreground" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setRevoking(t)}>Revoke Token</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ErrorNote error={actionError} />
        </div>
      </div>
      <ConfirmDialog open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)} title="Revoke Token"
        description={`Revoking ${revoking?.name ?? 'this token'} immediately breaks anything using it.`}
        confirmText="Revoke" destructive isLoading={busy} onConfirm={revoke} />
    </AccountShell>
  )
}
