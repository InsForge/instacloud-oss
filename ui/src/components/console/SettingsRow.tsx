// The console's settings rows (insta-frontend components/project/settings-row.tsx): a 480px label
// and hint column with the control on the right, and a card that puts a hairline between rows.

import { Children, Fragment, type ReactNode } from 'react'

export function SettingsRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  // The 480px label column is the console's desktop shape, but it cannot coexist with a control on
  // a narrow viewport: the row overflowed and the control sat off-screen inside the modal. Below
  // the breakpoint the label stacks above its control instead.
  return (
    <div className="flex flex-col items-stretch gap-2 md:flex-row md:items-start md:gap-6">
      <div className="flex flex-col gap-2 md:w-120 md:shrink-0">
        <span className="py-1.5 text-sm">{label}</span>
        {hint && <p className="pb-2 text-[13px] text-muted-foreground">{hint}</p>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function SettingsDivider() {
  return (
    <div className="flex h-5 items-center">
      <div className="h-px w-full bg-alpha-8" />
    </div>
  )
}

/** A settings panel: the card surface with a hairline between each row. Conditional rows leave
 *  null/false behind, and those are dropped before the rows are counted, so a missing row never
 *  leaves a rule with nothing under it. */
export function SettingsCard({ title, children }: { title?: string; children: ReactNode }) {
  const rows = Children.toArray(children).filter((row) => row !== '')
  return (
    <div className="flex flex-col rounded-lg border border-border bg-card p-4">
      {title && <h2 className="pb-2 text-base font-medium">{title}</h2>}
      {rows.map((row, i) => (
        <Fragment key={i}>
          {i > 0 && <SettingsDivider />}
          {row}
        </Fragment>
      ))}
    </div>
  )
}
