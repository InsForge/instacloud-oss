// The console's storage Buckets tab (insta-frontend storage/bucket-view.tsx): a Bucket card (name
// with copy, the Private/Public access toggle) over a Files card (refresh, Upload File, search, a
// Name / Size / Type / Uploaded At / Actions table, "This bucket is empty." when bare).
//
// Self-host divergences:
//   - the listing is the daemon's flat S3 page ({ key, size, lastModified }): the Type column is
//     derived from the key's extension (lib/objectRows.ts), where the console stores a contentType
//   - the access toggle applies immediately (the console stages it for Deploy)
//   - one page of up to 1000 objects, with a note when more exist (no pagination controls yet)

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Checkbox, ConfirmDialog, CopyButton, SearchInput, Skeleton, Switch, cn } from '@insforge/ui'
import { Download, Folder, RefreshCw, Trash2, Upload } from 'lucide-react'
import { api, type Service } from '../../api'
import type { PendingApproval } from '../ApprovalPrompt'
import { bucketFromEndpoint, objectRows, uploadContentType, type ObjectEntry } from '../../lib/objectRows'
import { formatDateTime } from '../../lib/format'
import { ErrorNote } from '../ui'

const PAGE_LIMIT = 1000

function Th({ children, className }: { children?: string; className?: string }) {
  return <th className={cn('px-4 py-3 text-left text-[13px] font-normal text-muted-foreground', className)}>{children}</th>
}

export function BucketsPanel({ projectId, branch, service, onDone, onApproval }: {
  projectId: string; branch: string; service: Service
  onDone: () => void; onApproval: (p: NonNullable<PendingApproval>) => void
}) {
  const bucket = bucketFromEndpoint(service.endpoint)
  const [objects, setObjects] = useState<ObjectEntry[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loadError, setLoadError] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [bucketSearch, setBucketSearch] = useState('')
  const [fileSearch, setFileSearch] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoadError(undefined)
    const r = await api.listObjects(projectId, service.id, branch, { limit: PAGE_LIMIT })
    if (r.kind === 'error') return setLoadError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void load() } })
    setObjects(r.data.objects)
    setTruncated(r.data.nextCursor !== undefined)
    // A refresh drops selections for keys that no longer exist.
    setSelected((prev) => new Set([...prev].filter((k) => r.data.objects.some((o) => o.key === k))))
  }, [projectId, service.id, branch, onApproval])
  useEffect(() => { void load() }, [load])

  const setAccess = async (isPublic: boolean) => {
    setActionError(undefined)
    const r = await api.setAccess(projectId, service.id, isPublic, branch)
    if (r.kind === 'error') return setActionError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void setAccess(isPublic) } })
    onDone()
  }

  const upload = async (file: File) => {
    setActionError(undefined)
    setBusy(true)
    try {
      const presign = await api.presignUpload(projectId, service.id,
        { key: file.name, contentType: uploadContentType(file.name, file.type), size: file.size }, branch)
      if (presign.kind === 'error') return setActionError(presign.error)
      if (presign.kind === 'approval') return onApproval({ ...presign, retry: () => { void upload(file) } })
      const form = new FormData()
      for (const [k, v] of Object.entries(presign.data.fields)) form.append(k, v)
      form.append('file', file) // the file must be the form's LAST field (S3 POST policy)
      const res = await fetch(presign.data.url, { method: 'POST', body: form })
      if (!res.ok) return setActionError(`Upload failed: the storage endpoint answered ${res.status}.`)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const download = async (key: string) => {
    setActionError(undefined)
    const r = await api.presignDownload(projectId, service.id, key, branch)
    if (r.kind === 'error') return setActionError(r.error)
    if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void download(key) } })
    // 60s TTL: hand it straight to the browser. A hidden anchor keeps SPA routing out of it.
    const a = document.createElement('a')
    a.href = r.data.url
    a.rel = 'noreferrer'
    a.click()
  }

  const removeKeys = async (keys: string[]) => {
    setActionError(undefined)
    setBusy(true)
    try {
      const r = keys.length === 1
        ? await api.deleteObject(projectId, service.id, keys[0], branch)
        : await api.deleteObjects(projectId, service.id, keys, branch)
      if (r.kind === 'error') return setActionError(r.error)
      if (r.kind === 'approval') return onApproval({ ...r, retry: () => { void removeKeys(keys) } })
      if ('failed' in r.data && r.data.failed.length) {
        setActionError(`${r.data.failed.length} object${r.data.failed.length === 1 ? '' : 's'} could not be deleted: ${r.data.failed[0].message}`)
      }
      await load()
    } finally {
      setBusy(false)
      setConfirmDelete(null)
    }
  }

  const rows = objectRows(objects ?? [], fileSearch)
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.key))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.key)))
  const toggle = (key: string) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const bucketVisible = !bucket || !bucketSearch.trim() || bucket.toLowerCase().includes(bucketSearch.trim().toLowerCase())
  const emptyMessage = loadError ? 'Files are unavailable right now.'
    : fileSearch.trim() ? 'No files match your search.' : 'This bucket is empty.'

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <h3 className="text-sm font-medium">Bucket</h3>
          <SearchInput value={bucketSearch} onChange={setBucketSearch} placeholder="Search bucket" className="w-64" debounceTime={0} />
        </div>
        <table className="w-full table-fixed">
          <thead>
            <tr className="border-y border-border bg-alpha-4">
              <Th>Bucket name</Th>
              <Th className="w-40 text-right">Access</Th>
            </tr>
          </thead>
          <tbody>
            {bucket && bucketVisible ? (
              <tr>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-[13px]">{bucket}</span>
                    <CopyButton text={bucket} showText={false} className="shrink-0" />
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-2">
                    <Switch checked={service.public === true} onCheckedChange={(v) => { void setAccess(v) }}
                      aria-label="Public access" />
                    <span className="text-sm text-muted-foreground">{service.public === true ? 'Public' : 'Private'}</span>
                  </div>
                </td>
              </tr>
            ) : (
              <tr>
                <td colSpan={2} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {bucket ? 'No bucket matches your search.' : 'This branch does not carry the bucket yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center gap-3 px-4 py-3">
          <h3 className="text-sm font-medium">Files</h3>
          <Button variant="ghost" size="icon-sm" aria-label="Refresh files" onClick={() => { void load() }}>
            <RefreshCw className="size-4 text-muted-foreground" />
          </Button>
          <Button variant="ghost" size="sm" className="gap-1.5 text-primary hover:text-primary" disabled={busy}
            onClick={() => fileInput.current?.click()}>
            <Upload className="size-4" />
            Upload File
          </Button>
          <input ref={fileInput} type="file" className="hidden" aria-hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = '' // the same file picked twice must fire again
              if (file) void upload(file)
            }} />
          {selected.size > 0 && (
            <Button variant="secondary" size="sm" className="gap-1.5 text-destructive" disabled={busy}
              onClick={() => setConfirmDelete([...selected])}>
              <Trash2 className="size-4" />
              Delete ({selected.size})
            </Button>
          )}
          <SearchInput value={fileSearch} onChange={setFileSearch} placeholder="Search files" className="ml-auto w-64" debounceTime={0} />
        </div>
        {objects === null && !loadError ? (
          <Skeleton className="m-4 h-40 rounded-lg" />
        ) : (
          <table className="w-full table-fixed">
            <thead>
              <tr className="border-y border-border bg-alpha-4">
                <th className="w-10 px-4 py-3">
                  <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Select all files" />
                </th>
                <Th>Name</Th>
                <Th className="w-24">Size</Th>
                <Th className="w-36">Type</Th>
                <Th className="w-52">Uploaded At</Th>
                <Th className="w-24">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">{emptyMessage}</td></tr>
              ) : rows.map((row) => (
                <tr key={row.key} className="border-b border-border transition-colors last:border-b-0 hover:bg-alpha-4">
                  <td className="px-4 py-2">
                    <Checkbox checked={selected.has(row.key)} onCheckedChange={() => toggle(row.key)}
                      aria-label={`Select ${row.name}`} />
                  </td>
                  <td className="truncate px-4 py-2 font-mono text-[13px]" title={row.key}>{row.key}</td>
                  <td className="px-4 py-2 text-sm text-muted-foreground">{row.sizeText}</td>
                  <td className="truncate px-4 py-2 text-sm text-muted-foreground">{row.type}</td>
                  <td className="px-4 py-2 text-sm text-muted-foreground">{formatDateTime(row.lastModified)}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon-sm" aria-label={`Download ${row.name}`}
                        onClick={() => { void download(row.key) }}>
                        <Download className="size-4 text-muted-foreground" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Delete ${row.name}`}
                        onClick={() => setConfirmDelete([row.key])}>
                        <Trash2 className="size-4 text-muted-foreground hover:text-destructive" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {truncated && (
        <p className="text-xs text-muted-foreground">Showing the first {PAGE_LIMIT} objects. Use the CLI for the full listing.</p>
      )}
      <ErrorNote error={loadError ?? actionError} />

      {confirmDelete && (
        <ConfirmDialog open onOpenChange={(o) => { if (!o) setConfirmDelete(null) }} title="Delete File"
          description={
            <span>
              This permanently deletes{' '}
              <span className="font-medium text-foreground">
                {confirmDelete.length === 1 ? confirmDelete[0] : `${confirmDelete.length} files`}
              </span>{' '}
              from the bucket. This cannot be undone.
            </span>
          }
          confirmText="Delete" cancelText="Cancel" destructive isLoading={busy}
          onConfirm={() => { void removeKeys(confirmDelete) }} />
      )}
    </div>
  )
}
