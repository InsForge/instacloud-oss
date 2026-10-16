// The console's auth shell (insta-frontend components/auth/auth-shell.tsx): the InstaCloud
// wordmark over a light card on a warm page, pinned to the light palette in both themes.

import type { ReactNode } from 'react'

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="light flex min-h-screen flex-col items-center bg-[#f4f2ee] px-4 pt-[120px] pb-16">
      <div className="flex w-full max-w-[400px] flex-col items-center gap-12">
        <img src="/instacloud-logo.svg" alt="InstaCloud" width={172} height={32} />
        <div className="flex w-full flex-col gap-6 bg-card p-6 shadow-[0px_8px_6px_rgba(0,0,0,0.04)]">
          <div className="flex flex-col gap-2">
            <h1 className="text-[32px] leading-12 font-semibold text-foreground">{title}</h1>
            <p className="text-sm leading-6 text-muted-foreground">{subtitle}</p>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}
