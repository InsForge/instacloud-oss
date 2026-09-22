// The console's Connect Database dialog (insta-frontend project/connect-database-dialog.tsx): the three ways into a
// database service — its connection URL, a raw client command derived from it, and the `insta run` wrapper — each in a
// read-only box with a reveal toggle and a copy button that always copies the real value.
//
// Self-host divergence: the console's managed databases are private until Public Access is on, and the dialog points at
// that toggle instead of a URL. The daemon's credentials route answers the host-facing lane address, which a client on
// this machine can reach, so every engine shows its URL (lib/databaseConnect.ts).

import { useEffect, useState, type ReactNode } from 'react'
import { Button, CopyButton, Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, Skeleton } from '@insforge/ui'
import { Eye, EyeOff } from 'lucide-react'
import { api } from '../../api'
import { connectUrlFor, dbRawCommand, instaCliRun, maskDsn, RAW_COMMAND_LABEL, type DbConnectEngine } from '../../lib/databaseConnect'

function ConnectRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-6">
      <span className="w-60 shrink-0 py-1.5 text-sm">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function CommandBox({ value, masked, label }: { value: string; masked?: string; label: string }) {
  const [revealed, setRevealed] = useState(false)
  const display = revealed ? value : (masked ?? value)
  return (
    <div className="flex items-center gap-1 rounded border border-alpha-12 bg-alpha-4 p-1.5">
      <span className="min-w-0 flex-1 truncate px-1 font-mono text-[13px]" title={display}>{display}</span>
      {masked !== undefined && masked !== value && (
        <Button variant="ghost" size="icon-sm" aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`} onClick={() => setRevealed(!revealed)}>
          {revealed ? <EyeOff className="size-4 text-muted-foreground" /> : <Eye className="size-4 text-muted-foreground" />}
        </Button>
      )}
      <CopyButton text={value} showText={false} className="shrink-0" />
    </div>
  )
}

function ConnectDivider() {
  return (
    <div className="flex h-5 items-center">
      <div className="h-px w-full bg-alpha-8" />
    </div>
  )
}

type Load = { state: 'pending' } | { state: 'ok'; credentials: Record<string, string> } | { state: 'gated' } | { state: 'error'; message: string }

export function ConnectDatabaseDialog({ projectId, branch, service, open, onOpenChange }: {
  projectId: string; branch: string
  service: { id: string; name: string; type: DbConnectEngine }
  open: boolean; onOpenChange: (open: boolean) => void
}) {
  const [load, setLoad] = useState<Load>({ state: 'pending' })

  // Read only while open: the route is gated (secrets.read), so nothing trips the gate until someone asks.
  useEffect(() => {
    if (!open) return
    let live = true
    setLoad({ state: 'pending' })
    void api.credentialsResult(projectId, service.id, branch).then((r) => {
      if (!live) return
      if (r.kind === 'ok') setLoad({ state: 'ok', credentials: r.data.credentials ?? {} })
      else if (r.kind === 'approval') setLoad({ state: 'gated' })
      else setLoad({ state: 'error', message: r.error })
    })
    return () => { live = false }
  }, [open, projectId, service.id, branch])

  const url = load.state === 'ok' ? connectUrlFor(service.type, load.credentials) : null
  const raw = url ? dbRawCommand(service.type, url) : null
  const unavailable = (
    <div className="flex min-h-8 items-center text-sm text-muted-foreground">
      {load.state === 'gated' ? 'Requires admin approval to view.' : load.state === 'error' ? load.message : '—'}
    </div>
  )
  const cell = (content: ReactNode) => (load.state === 'pending' ? <Skeleton className="h-8 w-full" /> : content ?? unavailable)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[720px]">
        <DialogHeader>
          <DialogTitle>Connect Database</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col">
          <ConnectRow label="Connection URL">
            {cell(url ? <CommandBox value={url} masked={maskDsn(url)} label="connection URL" /> : null)}
          </ConnectRow>
          <ConnectDivider />
          <ConnectRow label={RAW_COMMAND_LABEL[service.type]}>
            {cell(raw ? <CommandBox value={raw.full} masked={raw.masked} label="client command" /> : null)}
          </ConnectRow>
          <ConnectDivider />
          <ConnectRow label="InstaCloud CLI">
            {cell(raw ? <CommandBox value={instaCliRun(branch, raw.full)} masked={instaCliRun(branch, raw.masked)} label="CLI command" /> : null)}
          </ConnectRow>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
