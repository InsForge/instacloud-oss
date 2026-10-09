import { useState } from 'react'
import {
  Button, CopyButton, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@insforge/ui'
import { api, type ApiToken } from '../api'
import { cliLoginLine } from '../lib/apiUrl'
import { ErrorNote } from './ui'

const EXPIRY = [
  { key: 'never', label: 'Never expires' },
  { key: '30', label: '30 days' },
  { key: '90', label: '90 days' },
  { key: '365', label: '1 year' },
]

/** Create-and-reveal widget shared by Setup (step 2) and Account > API tokens: `POST /tokens`,
 *  then the one-time key and the exact `insta login --api-key ... --api-url ...` line. */
export function TokenCreate({ apiUrl, defaultName = 'laptop', showExpiry = false, onCreated }: {
  apiUrl: string; defaultName?: string; showExpiry?: boolean; onCreated?: (t: ApiToken) => void
}) {
  const [name, setName] = useState(defaultName)
  const [expiry, setExpiry] = useState('never')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [revealed, setRevealed] = useState<{ token: string; record: ApiToken } | null>(null)

  const create = async () => {
    const n = name.trim()
    if (!n) return setError('name is required')
    setBusy(true); setError(undefined)
    const r = await api.createToken(expiry === 'never' ? { name: n } : { name: n, expiresInDays: Number(expiry) })
    setBusy(false)
    if (r.kind === 'error') return setError(r.error)
    if (r.kind === 'approval') return setError('token creation is gated; grant it on the Approvals page and retry')
    setRevealed(r.data)
    onCreated?.(r.data.record)
  }

  if (revealed) {
    const line = cliLoginLine(revealed.token, apiUrl)
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Token <span className="font-medium text-foreground">{revealed.record.name}</span> created. This key is shown once.
        </p>
        <div className="flex items-center gap-2 rounded-md border border-border bg-semantic-1 px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-[13px]" title={revealed.token}>{revealed.token}</code>
          <CopyButton text={revealed.token} />
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Sign the CLI in with it</p>
          <div className="mt-1 flex items-center gap-2 rounded-md border border-border bg-semantic-1 px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[13px]">{line}</code>
            <CopyButton text={line} />
          </div>
        </div>
        <Button variant="secondary" size="sm" className="self-start" onClick={() => { setRevealed(null); setName('') }}>
          Create another
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label className="text-xs font-medium text-muted-foreground">Token name</label>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()} placeholder="laptop" className="mt-1" />
        </div>
        {showExpiry && (
          <div className="w-40">
            <label className="text-xs font-medium text-muted-foreground">Expiry</label>
            <Select value={expiry} onValueChange={setExpiry}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {EXPIRY.map((o) => <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
        <Button variant="primary" onClick={create} disabled={busy}>{busy ? 'Creating' : 'Create token'}</Button>
      </div>
      <p className="text-xs text-muted-foreground">
        An <code className="font-mono">insta_</code> key for the CLI, MCP or an agent. It carries the admin&apos;s full access.
      </p>
      <ErrorNote error={error} />
    </div>
  )
}
