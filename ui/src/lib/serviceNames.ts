// Default names for new services (the console's lib/service-names.ts), so a create dialog opens
// with a valid, unique name instead of an empty field: a typed service defaults to its type, an
// Empty Service to a whimsical pair, and collisions count up ("redis-2"). Plus the name an image
// reference suggests, for the Docker Image flow.

/** The daemon's service-name rule: lower-kebab, 1 to 39 chars, no leading or trailing hyphen. */
export const SERVICE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$/

/** What every create and rename surface says when the rule rejects (the console's copy). */
export const LOWER_KEBAB_NAME_ERROR = 'Use lowercase letters, digits, and hyphens (must start with a letter or digit).'

/** The daemon's branch-name rule (engine.ts BRANCH_NAME_RE). A branch name becomes part of every
 *  hostname and URL that addresses the environment, so a name with a space, `/`, `?` or `#` would
 *  create an environment its own URL cannot reach. */
export const BRANCH_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/
export const LOWER_KEBAB_BRANCH_ERROR =
  'Use lowercase letters, digits, and hyphens (must start and end with a letter or digit).'

const MAX_NAME_LENGTH = 39

/** `base` if free, else the first free "base-2", "base-3", …, trimming the base so the suffix fits. */
export function uniqueServiceName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; n <= taken.size + 2; n += 1) {
    const suffix = `-${n}`
    const candidate = base.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix
    if (!taken.has(candidate)) return candidate
  }
  return base
}

const ADJECTIVES = [
  'amber', 'bold', 'brave', 'calm', 'coral', 'crisp', 'eager', 'gentle', 'golden', 'happy', 'ivory', 'jolly', 'lively',
  'lunar', 'mellow', 'misty', 'noble', 'polar', 'quiet', 'rapid', 'royal', 'silver', 'sunny', 'swift', 'vivid', 'witty',
] as const

const NOUNS = [
  'aurora', 'breeze', 'canyon', 'cloud', 'comet', 'creek', 'delta', 'ember', 'falcon', 'fjord', 'glade', 'harbor', 'island',
  'lagoon', 'meadow', 'moon', 'otter', 'peak', 'pebble', 'pine', 'reef', 'river', 'sparrow', 'star', 'tide', 'willow',
] as const

/** A random "adjective-noun" pair; uniqueness is uniqueServiceName's job. */
export function whimsicalBaseName(random: () => number = Math.random): string {
  const pick = (words: readonly string[]) => words[Math.min(words.length - 1, Math.floor(random() * words.length))]
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`
}

/** The service name an image reference suggests: its last path segment without tag or digest,
 *  lower-kebab. Empty when nothing usable is left (e.g. ":latest"). */
export function suggestServiceName(ref: string): string {
  const last = ref.trim().split('/').pop() ?? ''
  const base = (last.split('@')[0] ?? '').split(':')[0] ?? ''
  const kebab = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_NAME_LENGTH).replace(/-+$/, '')
  return SERVICE_NAME_RE.test(kebab) ? kebab : ''
}
