// The console's page shell (insta-frontend's Service, Environments and Secrets views all repeat
// it): a full-width title band escaping <main>'s padding, the page action at its right, then the
// content at the design's 24px inset.

import type { ReactNode } from 'react'

export function ConsolePage({ title, subtitle, action, children }: {
  title: string; subtitle?: ReactNode; action?: ReactNode; children: ReactNode
}) {
  return (
    <div className="relative -mx-8 -mt-8 flex w-auto flex-col gap-4">
      <div className="px-6">
        <div className="flex items-start justify-between gap-3 py-4.5">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-[32px] leading-12 font-semibold">{title}</h1>
            {subtitle && <p className="text-[13px] text-muted-foreground">{subtitle}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2 pt-1.5">{action}</div>}
        </div>
      </div>
      <div className="flex flex-col gap-4 px-6">{children}</div>
    </div>
  )
}
