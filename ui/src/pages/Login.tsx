// Sign in, as the console's sign-in page and form (insta-frontend (auth)/signin/page.tsx,
// components/auth/sign-in-form.tsx). Self-host divergences: no OAuth buttons (the daemon has one
// password admin), no "Forgot password?" (a lost admin password is reset on the box with
// `instad --reset-admin`), and in place of "Sign Up Now" a link to create the admin on first run.

import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { Button, InputField } from '@insforge/ui'
import { Eye, EyeOff } from 'lucide-react'
import { api } from '../api'
import { safeNext, useAuth } from '../components/AuthGate'
import { AuthShell } from '../components/console/AuthShell'

export function Login() {
  const auth = useAuth()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (auth.mode !== 'server') return <Navigate to="/" replace />
  if (auth.user) return <Navigate to={safeNext(params.get('next'))} replace />

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!email.trim() || !password) return
    setPending(true); setError(null)
    const r = await api.signIn({ email: email.trim(), password })
    setPending(false)
    if (r.kind === 'error') {
      if (r.status === 401) return setError('Wrong email or password.')
      if (r.status === 429) return setError('Too many attempts; try again later.')
      return setError(r.error)
    }
    if (r.kind === 'approval') return setError('Unexpected approval response on sign-in.')
    await auth.refresh()
    nav(safeNext(params.get('next')), { replace: true })
  }

  return (
    <AuthShell title="Sign In" subtitle="Welcome back. Sign in to continue">
      <form onSubmit={onSubmit} className="flex flex-col gap-6">
        <InputField label="Email" type="email" name="email" autoComplete="email" autoFocus
          showIcon={false} showDropdown={false} showTip={false} showTipBadge={false}
          placeholder="example@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <InputField label="Password" type={showPassword ? 'text' : 'password'} name="password" autoComplete="current-password"
          showIcon={false} showTip={false} showTipBadge={false}
          dropdownIcon={
            <button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="flex items-center justify-center text-muted-foreground hover:text-foreground"
              onClick={() => setShowPassword((v) => !v)}>
              {showPassword ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
            </button>
          }
          placeholder="••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" variant="primary" className="w-full" disabled={pending || !email.trim() || !password}>
          {pending ? 'Signing in…' : 'Sign In'}
        </Button>
        {auth.setupRequired && (
          <p className="text-center text-sm leading-6 text-muted-foreground">
            First run?{'  '}
            <Link to="/setup" className="font-medium text-foreground hover:underline">Create the admin</Link>
          </p>
        )}
      </form>
    </AuthShell>
  )
}
