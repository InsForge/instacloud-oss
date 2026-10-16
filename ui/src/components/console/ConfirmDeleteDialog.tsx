// The console's type-to-confirm delete (insta-frontend components/confirm-delete-dialog.tsx): the
// destructive button stays disabled until the resource's own name is retyped. That proves WHICH
// resource, which is the mistake that happens when Delete sits a few pixels under Rename. Shaped
// like @insforge/ui's ConfirmDialog (480px, header, body, footer pair, await-then-close).

import { useId, useState, type ReactNode } from 'react'
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input } from '@insforge/ui'
import { nameMatches } from '../../lib/nameMatches'

export function ConfirmDeleteDialog({
  open, onOpenChange, title, description, name, confirmText = 'Delete', cancelText = 'Cancel', isLoading = false, onConfirm,
}: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: ReactNode; name: string
  confirmText?: string; cancelText?: string; isLoading?: boolean; onConfirm: () => void | Promise<void>
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {/* The typed name lives one level down: Radix unmounts content on close, so cancelling
            clears it instead of surviving a reopen still matching. */}
        <ConfirmDeleteForm key={name} description={description} name={name} confirmText={confirmText}
          cancelText={cancelText} isLoading={isLoading} onConfirm={onConfirm} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  )
}

function ConfirmDeleteForm({ description, name, confirmText, cancelText, isLoading, onConfirm, onOpenChange }: {
  description: ReactNode; name: string; confirmText: string; cancelText: string; isLoading: boolean
  onConfirm: () => void | Promise<void>; onOpenChange: (open: boolean) => void
}) {
  const [typed, setTyped] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputId = useId()
  // `isLoading` is optional and no caller sets it, so the in-flight guard has to live here: the
  // button stayed enabled while the DELETE was in flight, and a second Enter or click sent it
  // again. The second request then reported "not found" for a resource the first one had removed.
  const blocked = !nameMatches(typed, name) || isLoading || submitting
  return (
    <form onSubmit={(event) => {
      event.preventDefault()
      // Enter is a real path here, so the guard lives here too and not only on the button.
      if (blocked) return
      setSubmitting(true)
      void (async () => {
        try { await onConfirm(); onOpenChange(false) }
        finally { setSubmitting(false) }
      })()
    }}>
      <DialogBody className="flex flex-col gap-4">
        <div className="text-sm leading-5 text-muted-foreground">{description}</div>
        <div className="flex flex-col gap-2">
          <label htmlFor={inputId} className="text-sm text-muted-foreground">
            Type <span className="font-semibold break-all text-foreground select-text">{name}</span> to confirm
          </label>
          <Input id={inputId} autoFocus autoComplete="off" spellCheck={false} autoCorrect="off" autoCapitalize="none"
            value={typed} onChange={(event) => setTyped(event.target.value)} />
        </div>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="secondary" size="lg" disabled={isLoading} onClick={() => onOpenChange(false)}>{cancelText}</Button>
        <Button type="submit" variant="destructive" size="lg" disabled={blocked}>{isLoading ? 'Processing...' : confirmText}</Button>
      </DialogFooter>
    </form>
  )
}
