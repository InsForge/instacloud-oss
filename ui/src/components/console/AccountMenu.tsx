// The console's account menu (insta-frontend components/auth/account-menu.tsx): a round initials
// avatar opening Theme and Log out. Self-host divergences: "API Tokens" stands where the console
// has Profile (the daemon has one admin and no profile page, and tokens are how the CLI signs in),
// and local mode, which has no identity, keeps only Theme.

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@insforge/ui'
import { Check, KeyRound, LogOut, Monitor, Moon, Sun, SunMoon, type LucideIcon } from 'lucide-react'
import { useAuth } from '../AuthGate'
import { useTheme, type ThemePreference } from '../../lib/theme'

const themeOptions: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

/** One or two letters: the name's initials, else the email's first letter. */
export function userInitials(user: { name?: string | null; email?: string | null } | null): string {
  const name = user?.name?.trim()
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean)
    return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
  }
  return (user?.email?.trim()[0] ?? '?').toUpperCase()
}

export function AccountMenu() {
  const auth = useAuth()
  const nav = useNavigate()
  const { theme, setTheme } = useTheme()
  const [pending, setPending] = useState(false)
  const server = auth.mode === 'server'

  const onLogout = async () => {
    setPending(true)
    await auth.signOut()
    nav('/login', { replace: true })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Account" title={auth.user?.email ?? undefined}
          className="ml-1 flex size-8 items-center justify-center overflow-hidden rounded-full border border-border bg-alpha-8 text-xs font-semibold text-primary">
          {server ? userInitials(auth.user) : 'L'}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {server && (
          <DropdownMenuItem onSelect={() => nav('/account/tokens')}>
            <KeyRound className="size-4" />
            API Tokens
          </DropdownMenuItem>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <SunMoon className="size-4" />
            Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {themeOptions.map(({ value, label, icon: Icon }) => (
              <DropdownMenuItem key={value} onSelect={() => setTheme(value)}>
                <Icon className="size-4" />
                {label}
                {theme === value && <Check className="ml-auto size-4" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {server && (
          <DropdownMenuItem onSelect={() => { void onLogout() }} disabled={pending}>
            <LogOut className="size-4" />
            {pending ? 'Signing out…' : 'Log out'}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
