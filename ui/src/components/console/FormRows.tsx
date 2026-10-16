// The console's create-dialog rows (insta-frontend services/service-form-rows.tsx): a 240px label
// column with an optional hint, the control on the right; Advanced Settings hides options that
// already have a working default.

import { useId, type ReactNode } from 'react'
import { DialogDivider, Input, Switch } from '@insforge/ui'
import { ChevronRight } from 'lucide-react'

export const DEFAULT_VOLUME_GIB = 1

/** `htmlFor` makes the row's text a real label for its control. Without it the create and Docker
 *  Image dialogs exposed unlabelled fields to a screen reader: the text sat in a sibling span with
 *  nothing tying the two together. Callers pass the id they give the input. */
export function FormRow({ htmlFor, label, hint, children }: {
  htmlFor?: string; label: ReactNode; hint?: string; children: ReactNode
}) {
  // 240px of label plus a 24px gap leaves no usable width in a dialog on a phone, so the row
  // stacks below the breakpoint rather than squeezing or overflowing the control.
  return (
    <div className="flex flex-col items-stretch gap-2 md:flex-row md:items-start md:gap-6">
      <div className="flex flex-col gap-2 md:w-60 md:shrink-0">
        <label htmlFor={htmlFor} className="py-1.5 text-sm">{label}</label>
        {hint && <p className="pb-2 text-[13px] text-muted-foreground">{hint}</p>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function AdvancedSettings({ open, onOpenChange, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode
}) {
  // aria-expanded alone says the button toggles SOMETHING; aria-controls says what, so a screen
  // reader can associate it with the Always On and Volume options it reveals.
  const regionId = useId()
  return (
    <>
      <DialogDivider />
      <button type="button" aria-expanded={open} aria-controls={regionId} onClick={() => onOpenChange(!open)}
        className="flex items-center gap-1.5 self-start py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className={`size-4 transition-transform ${open ? 'rotate-90' : ''}`} />
        Advanced Settings
      </button>
      {/* Always rendered so the id aria-controls names exists in both states. `contents` keeps the
          rows as direct flex children when open, exactly as they were before this wrapper. The
          `hidden` ATTRIBUTE would not work here: display:contents overrides it. */}
      <div id={regionId} className={open ? 'contents' : 'hidden'}>{children}</div>
    </>
  )
}

/** The compute create dialogs' Volume row. A volume can also be attached later from the service's
 *  Volume tab, but creating with one saves the redeploy a later attach needs. */
export function VolumeFormRow({ enabled, onEnabledChange, sizeGib, onSizeChange }: {
  enabled: boolean; onEnabledChange: (enabled: boolean) => void; sizeGib: string; onSizeChange: (sizeGib: string) => void
}) {
  return (
    <>
      <DialogDivider />
      <FormRow label="Volume"
        hint="A persistent disk mounted at /data. You can also attach one later from the service's Volume tab.">
        <div className="flex flex-col gap-2">
          <Switch checked={enabled} onCheckedChange={onEnabledChange} aria-label="Attach volume" />
          {enabled && (
            <div className="flex items-center gap-2">
              <Input name="volumeGib" inputMode="numeric" className="w-24" placeholder={String(DEFAULT_VOLUME_GIB)}
                value={sizeGib} onChange={(e) => onSizeChange(e.target.value)} aria-label="Volume size in GB" />
              <span className="text-sm text-muted-foreground">GB</span>
            </div>
          )}
        </div>
      </FormRow>
    </>
  )
}
