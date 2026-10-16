// First visit in server mode, as the console's sign-up page and form (insta-frontend
// (auth)/signup/page.tsx, components/auth/sign-up-form.tsx): Email and Create Password with the
// live password checklist. Self-host divergences: the one account is the admin (no email
// verification, captcha, OAuth or legal consent), and a CLI-token step follows, since tokens are
// how the CLI signs in to a self-hosted box.

import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { Button, cn, InputField } from '@insforge/ui'
import { Check, Circle, Eye, EyeOff } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../components/AuthGate'
import { AuthShell } from '../components/console/AuthShell'
import { TokenCreate } from '../components/TokenCreate'
import { apiUrlForCli } from '../lib/apiUrl'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The console's live password rules. All must pass to submit. */
export const PASSWORD_RULES = [
  { label: 'At least 1 Uppercase letter', test: (v: string) => /[A-Z]/.test(v) },
  { label: 'At least 1 Number', test: (v: string) => /[0-9]/.test(v) },
  { label: 'Special character (e.g. !?<>@#$%)', test: (v: string) => /[^A-Za-z0-9]/.test(v) },
  { label: '8 characters or more', test: (v: string) => v.length >= 8 },
]

export function Setup() {
  const auth = useAuth()
  const nav = useNavigate()
  const [step, setStep] = useState<'form' | 'token'>('form')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exists, setExists] = useState(false)

  if (auth.mode !== 'server') return <Navigate to="/" replace />
  if (step === 'form' && !auth.setupRequired) return <Navigate to="/" replace />

  const rules = PASSWORD_RULES.map((rule) => ({ ...rule, met: rule.test(password) }))
  const passwordValid = rules.every((rule) => rule.met)
  const confirmValid = confirm === password
  const emailValid = EMAIL_RE.test(email.trim())

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!emailValid || !passwordValid || !confirmValid) return
    setPending(true); setError(null); setExists(false)
    const r = await api.signUp({ email: email.trim(), password })
    setPending(false)
    if (r.kind === 'error') {
      if (r.status === 422) { setExists(true); return setError('An admin already exists. Sign in instead.') }
      return setError(r.error)
    }
    if (r.kind === 'approval') return setError('Unexpected approval response on sign-up.')
    await auth.refresh()
    setStep('token')
  }

  if (step === 'token') {
    const apiUrl = auth.boot.apiUrl || apiUrlForCli(location.origin)
    return (
      <AuthShell title="Create a CLI token" subtitle="Optional. You can also create tokens later from the account menu.">
        <TokenCreate apiUrl={apiUrl} defaultName="laptop" />
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="secondary" onClick={() => nav('/')}>Skip</Button>
          <Button variant="primary" onClick={() => nav('/')}>Open dashboard</Button>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Get Started" subtitle="Create the admin account">
      <form onSubmit={onSubmit} className="flex flex-col gap-6">
        <InputField label="Email" type="email" name="email" autoComplete="email" autoFocus
          showIcon={false} showDropdown={false} showTip={false} showTipBadge={false}
          placeholder="example@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <div className="flex flex-col gap-2">
          <InputField label="Create Password" type={showPassword ? 'text' : 'password'} name="password" autoComplete="new-password"
            showIcon={false} showTip={false} showTipBadge={false}
            dropdownIcon={
              <button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="flex items-center justify-center text-muted-foreground hover:text-foreground"
                onClick={() => setShowPassword((v) => !v)}>
                {showPassword ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
              </button>
            }
            placeholder="••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
          <ul className="flex flex-col gap-1">
            {rules.map((rule) => (
              <li key={rule.label} className="flex items-center gap-2 text-sm">
                {rule.met ? <Check className="size-5 shrink-0 text-success" /> : <Circle className="size-5 shrink-0 text-muted-foreground" />}
                <span className={cn(rule.met ? 'text-foreground' : 'text-muted-foreground')}>{rule.label}</span>
              </li>
            ))}
          </ul>
        </div>
        {/* The console can drop a confirm field because it has email verification and a "Forgot
            password?" flow. Self-hosting has neither: recovery is `instad --reset-admin`, which
            needs shell access to the box. A single typo here would lock the operator out of their
            own dashboard until they can SSH in, so the confirmation stays. */}
        <InputField label="Confirm Password" type={showPassword ? 'text' : 'password'} name="confirm"
          autoComplete="new-password" showIcon={false} showDropdown={false} showTip={false} showTipBadge={false}
          placeholder="••••••" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {confirm && !confirmValid && <p className="text-sm text-destructive">Both passwords must match.</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" variant="primary" className="w-full" disabled={pending || !emailValid || !passwordValid || !confirmValid}>
          {pending ? 'Creating account…' : 'Create Account'}
        </Button>
        {exists && (
          <p className="text-center text-sm leading-6 text-muted-foreground">
            Already have an account?{'  '}
            <Link to="/login" className="font-medium text-foreground hover:underline">Sign In Now</Link>
          </p>
        )}
      </form>
    </AuthShell>
  )
}
