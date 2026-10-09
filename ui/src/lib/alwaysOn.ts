// What the add-service dialog's Always on switch shows, and what a compute create sends. Pure, so
// the root vitest covers it: the dashboard has no component-test setup, and this is the whole of
// the decision the dialog makes.

export interface AlwaysOnInput {
  /** The user's explicit choice; null while the switch is untouched. */
  picked: boolean | null
  /** The daemon's INSTA_OSS_ALWAYS_ON_DEFAULT, as the shell reported it. */
  bootDefault: boolean
  /** Whether the dialog's branch is the project's default branch; undefined while the branch
   *  list is loading, or when it could not be read. */
  isDefaultBranch: boolean | undefined
}

export interface AlwaysOnChoice {
  /** What the switch shows. */
  value: boolean
  /** Whether that is what the daemon will actually do. */
  known: boolean
  /** What the create request carries: a value pins the service on every branch, undefined lets
   *  the branch decide (always-on on the default branch when the daemon's default is on). */
  send: boolean | undefined
}

export function alwaysOnChoice({ picked, bootDefault, isDefaultBranch }: AlwaysOnInput): AlwaysOnChoice {
  if (picked !== null) return { value: picked, known: true, send: picked }
  // Untouched and the branch is not known yet: whatever the switch showed could be wrong, and an
  // untouched create sends nothing, so the daemon would decide by a rule the screen did not show.
  if (isDefaultBranch === undefined) return { value: false, known: false, send: undefined }
  return { value: bootDefault && isDefaultBranch, known: true, send: undefined }
}

/** A compute create may go out only when the switch shows what the daemon will do. */
export function canSubmitCompute(c: AlwaysOnChoice): boolean {
  return c.known
}
