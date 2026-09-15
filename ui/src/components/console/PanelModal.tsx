// The console's popup panel shell (insta-frontend components/panel-modal.tsx): a dimmed backdrop under a squared
// panel centered in the page, with a bordered title band and a bare X close, beside an optional settings sidebar.
// A panel holding unsaved changes shows a save footer, and closing is refused while it is there: the footer
// flashes instead.
//
// Self-host divergence: none in what it draws. It is a plain fixed div like ServiceDetailModal, so it also moves
// focus in, traps Tab, gives focus back on close, and lets a nested dialog take Escape first (nestedDialog.ts).

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { cn, DialogFooter } from '@insforge/ui'
import { X } from 'lucide-react'
import { hasOpenNestedDialog } from './nestedDialog'

const SAVE_ATTENTION_EVENT = 'panel-save-attention'

/** Whether an unsaved footer blocked leaving; draws attention to it if so. */
export function highlightUnsavedPanelFooter(container: ParentNode | null): boolean {
  const footer = container?.querySelector('[data-panel-unsaved-changes]')
  if (!footer) return false
  footer.dispatchEvent(new Event(SAVE_ATTENTION_EVENT))
  return true
}

export function PanelSaveFooter({ children }: { children: ReactNode }) {
  const footerRef = useRef<HTMLDivElement>(null)
  const [highlighted, setHighlighted] = useState(false)
  useEffect(() => {
    const footer = footerRef.current
    let timer: ReturnType<typeof setTimeout> | undefined
    const highlight = () => {
      setHighlighted(true)
      clearTimeout(timer)
      timer = setTimeout(() => setHighlighted(false), 1400)
    }
    footer?.addEventListener(SAVE_ATTENTION_EVENT, highlight)
    return () => {
      footer?.removeEventListener(SAVE_ATTENTION_EVENT, highlight)
      clearTimeout(timer)
    }
  }, [])
  return (
    <DialogFooter ref={footerRef} data-panel-unsaved-changes data-highlighted={highlighted || undefined}
      className={cn('shrink-0 flex-wrap transition-colors duration-200 motion-reduce:transition-none', highlighted ? 'border-t-warning bg-warning/10' : 'bg-semantic-1')}>
      {children}
      {highlighted && <span role="status" className="sr-only">Save or discard your changes before leaving.</span>}
    </DialogFooter>
  )
}

export function CloseButton({ onClose, className }: { onClose: () => void; className?: string }) {
  return (
    <button type="button" aria-label="Close" onClick={onClose}
      className={cn('flex size-7 shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground', className)}>
      <X className="size-5" />
    </button>
  )
}

export function PanelModal({ title, sidebar, bodyClassName, closeOnOutsideClick = true, onClose, children }: {
  title: string
  /** Settings navigation, kept beside the independently scrolling content. */
  sidebar?: ReactNode
  /** Lets a panel with footer actions own its scrolling body. */
  bodyClassName?: string
  /** Whether clicking the backdrop dismisses the panel. */
  closeOnOutsideClick?: boolean
  onClose: () => void
  children: ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const requestClose = useCallback(() => {
    // Settings footers mark their unsaved state; read at dismissal time so Save and Discard cannot leave a stale guard.
    if (highlightUnsavedPanelFooter(panelRef.current)) return
    onClose()
  }, [onClose])

  // Capture phase on window, as in ServiceDetailModal: answered before Radix's document listener can close a nested
  // dialog and report it closed, so one Escape never closes both layers.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (hasOpenNestedDialog(panelRef.current)) return
      requestClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [requestClose])

  // aria-modal promises the page behind is inert, so keep focus inside and give it back on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const root = panelRef.current
    const focusable = () => Array.from(
      root?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((el) => el.offsetParent !== null && el.tabIndex >= 0)
    focusable()[0]?.focus()
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !root || hasOpenNestedDialog(root)) return
      const items = focusable()
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (!root.contains(active)) { e.preventDefault(); first.focus(); return }
      if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
    }
    document.addEventListener('keydown', onTab)
    return () => {
      document.removeEventListener('keydown', onTab)
      opener?.focus?.()
    }
  }, [])

  return (
    <div ref={panelRef} className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/80" onClick={closeOnOutsideClick ? requestClose : undefined} />
      {/* Anchored to the center of the page; height capped so at least 64px of backdrop stays above and below. */}
      <div className={cn(
        'absolute top-1/2 left-1/2 flex max-h-[calc(100%-8rem)] max-w-[calc(100vw-3rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden border border-border bg-semantic-1 shadow-[0px_8px_12px_0px_rgba(0,0,0,0.24)]',
        sidebar ? 'h-[740px] w-[1024px] flex-col sm:flex-row' : 'w-[800px] flex-col',
      )}>
        {sidebar}
        <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', sidebar && 'bg-semantic-1')}>
          <div className={cn('flex shrink-0 items-center gap-3 border-b border-border', sidebar ? 'px-4 py-3' : 'px-6 py-4')}>
            <h2 className={cn('min-w-0 truncate leading-7', sidebar ? 'text-base font-medium' : 'text-lg font-semibold')}>{title}</h2>
            <CloseButton onClose={requestClose} className="ml-auto" />
          </div>
          <div className={cn('@container min-h-0 flex-1 overflow-y-auto overscroll-contain', sidebar ? 'p-4' : 'px-6 py-5', bodyClassName)}>
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
