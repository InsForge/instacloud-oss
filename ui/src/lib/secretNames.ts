// The name rule for a NEW secret or variable (insta-frontend secrets/secret-dialog.tsx `USER_SECRET_NAME_RE`). Pure so
// the root vitest covers it.
//
// Self-host divergence: the console demands SCREAMING_SNAKE_CASE within 64 characters. The daemon's CLI has always
// accepted lowercase names, so the rule here is the one an environment variable actually needs: letters, digits and
// underscores, not starting with a digit. It applies only when adding; an existing name is never re-checked, so a
// secret created with the CLI stays editable from the dashboard.

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Why `name` cannot be a new secret's name, or null when it can. `name` is already trimmed. */
export function newSecretNameError(name: string): string | null {
  if (!name) return 'A name is required.'
  if (!ENV_NAME_RE.test(name)) return 'Use letters, digits and underscores, not starting with a digit (like API_KEY).'
  return null
}
