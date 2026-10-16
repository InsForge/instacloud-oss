import { type ReactNode } from 'react'
import { templateCategoryLabel } from '../lib/templatePicker'
import {
  Button,
  cn,
  CopyButton,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@insforge/ui'
import { Database, ExternalLink, HardDrive, Loader2, Moon, Server, type LucideIcon } from 'lucide-react'
import { deriveStatus, type HealthRow, type ServiceStatus, type StatusRow } from '../lib/status'
import type { RunMode } from '../lib/mode'

/** Derived service status (lib/status.ts) as dot + label, with the Wake button when the row is a
 *  sleeping compute service (the cloud's start route is compute-only). */
export function StatusCell({ row, health, waking = false, onWake, busy = false }: {
  row: StatusRow; health?: HealthRow; waking?: boolean; onWake?: () => void; busy?: boolean
}) {
  const s = deriveStatus(row, health, waking)
  return (
    <span className="inline-flex items-center gap-2">
      <StatusLabel status={s} />
      {s.wakeable && onWake && (
        <Button variant="secondary" size="sm" className="h-6 px-2 text-xs" disabled={busy}
          onClick={(e) => { e.stopPropagation(); onWake() }} title="Start the container now (it also wakes on the next request)">
          Wake
        </Button>
      )}
    </span>
  )
}

export function StatusLabel({ status: s }: { status: ServiceStatus }) {
  const spinning = s.kind === 'starting' || s.kind === 'waking'
  const text = s.kind === 'online' ? 'text-success'
    : s.kind === 'crashed' ? 'text-destructive'
    : spinning ? 'text-info'
    : 'text-muted-foreground'
  const dot = s.kind === 'online' ? 'bg-success' : s.kind === 'crashed' ? 'bg-destructive' : 'bg-disabled'
  return (
    <span className={cn('inline-flex items-center gap-2 text-sm', text)} title={s.title}>
      {spinning ? <Loader2 className="size-3.5 animate-spin" />
        : s.kind === 'sleeping' ? <Moon className="size-3.5" />
        : <span className={cn('size-1.5 rounded-full', dot)} />}
      {s.kind === 'unknown' ? '—' : s.label}
    </span>
  )
}

/** Build the browser URL for a row: server mode `https://<domain>`, local `http://<endpoint>`
 *  (the daemon's `endpoint` is `host[:port]`, decision 40). */
export function hrefFor(mode: RunMode, domain?: string, endpoint?: string): string | undefined {
  if (mode === 'server') return domain ? `https://${domain}` : undefined
  const target = endpoint ?? domain
  return target ? `http://${target}` : undefined
}

/** Hostname column: compute rows link to the app (a sleeping one wakes on the request, so the
 *  link keeps working); database and storage rows show their `host:port` endpoint. Copy copies
 *  what a client would use. */
export function HostLink({ domain, endpoint, mode, link, sleeping = false, className }: {
  domain?: string; endpoint?: string; mode: RunMode; link: boolean; sleeping?: boolean; className?: string
}) {
  const href = link ? hrefFor(mode, domain, endpoint) : undefined
  const shown = link ? domain ?? endpoint : endpoint ?? domain
  if (!shown) return <span className="text-sm text-muted-foreground">—</span>
  const copyText = href ?? shown
  return (
    <span className={cn('inline-flex min-w-0 max-w-full items-center gap-1', className)} onClick={(e) => e.stopPropagation()}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer"
          title={sleeping ? 'Sleeping; opening this URL wakes it' : href}
          className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-xs text-foreground hover:underline">
          <span className="truncate">{shown}</span>
          <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
        </a>
      ) : (
        <span className="truncate font-mono text-xs text-muted-foreground" title={shown}>{shown}</span>
      )}
      <CopyButton text={copyText} className="shrink-0" />
    </span>
  )
}

/** Environment status chip, same styles as the console's EnvStatusBadge. */
export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md bg-warning px-2 py-0.5 text-xs font-medium text-inverse">
      {children}
    </span>
  )
}

/** Controlled modal over the @insforge/ui Radix dialog (no trigger: pages open it from state). */
export function Modal({ title, onClose, children, footer, wide = false }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={wide ? 'max-w-3xl' : undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>{children}</DialogBody>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  )
}

export function ErrorNote({ error }: { error?: Error | string }) {
  if (!error) return null
  return <p className="mt-3 text-sm text-destructive">{typeof error === 'string' ? error : error.message}</p>
}

/** Label above a control; shared by the auth pages and every dialog. */
export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** Settings section: a title, a one-line description, then its controls. */
export function Section({ title, description, children, danger = false }: {
  title: string; description?: string; children: ReactNode; danger?: boolean
}) {
  return (
    <section className={cn('rounded-lg border bg-card p-4', danger ? 'border-destructive/40' : 'border-border')}>
      <h2 className={cn('text-sm font-semibold', danger && 'text-destructive')}>{title}</h2>
      {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

/** Service-type icon on a semantic surface, like the console's ServiceTypeIcon tile (lucide
 *  Database instead of the postgres brand mark; no icon dependency here). */
export function TypeIcon({ type, className }: { type: string; className?: string }) {
  const Icon: LucideIcon = type === 'postgres' || type === 'redis' || type === 'mysql' || type === 'mongodb' ? Database
    : type === 'storage' ? HardDrive : Server
  return (
    <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg bg-semantic-1', className)}>
      <Icon className="size-5 text-muted-foreground" />
    </span>
  )
}

/** Template logo (a data: URI on self-host, decision 29) with a monogram fallback tile. */
export function TemplateLogo({ src, name, className }: { src?: string | null; name: string; className?: string }) {
  if (src) {
    return <img src={src} alt="" className={cn('size-9 shrink-0 rounded-lg bg-semantic-1 object-contain p-1', className)} />
  }
  return (
    <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg bg-semantic-1 text-sm font-semibold text-muted-foreground uppercase', className)}>
      {name.trim().charAt(0) || '?'}
    </span>
  )
}

/** The cloud's category label ("AI Agent", "LLM", "Automation"), shared with the Deploy a Template picker. */
export function categoryLabel(category: string): string {
  return templateCategoryLabel(category)
}

/** Sleeping hint for the database page. */
export const SLEEPING_ICON = Moon
