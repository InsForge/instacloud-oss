// Git push-to-deploy for the self-hosted daemon (server mode). A compute service can be bound to a
// GitHub repo; a push to the tracked branch hits POST /webhooks/git/<id>, which this module verifies
// (HMAC over the raw body, RFC-style constant-time) and turns into a build + redeploy. The daemon
// builds the repo itself with `docker build <git-context-url>`, which BuildKit fetches directly, so
// no local git clone is needed. This is the self-hosted equivalent of the cloud's GitHub App flow,
// which needs a multi-tenant app and is left at 501; here a per-service Personal Access Token (or a
// public repo, no token) is the whole auth model.
//
// Token handling: the token rides the build-context URL as `https://x-access-token:<token>@host/...`
// so the existing redactDockerArgs DSN pattern (src/docker.ts) strips it from every error, log and
// persisted deployment row. It is stored only as part of the binding in state.json (0600), never
// echoed by a route.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

/** A compute service's git binding, stored under the branch's app in state. `token` is a GitHub PAT
 *  (or empty for a public repo); `webhookSecret` verifies the push. */
export interface GitBinding {
  id: string
  owner: string
  repo: string
  ref: string
  token: string
  webhookSecret: string
  createdAt: string
  lastDeployedSha?: string
}

/** A binding as stored in state.json: the repo binding plus the compute target it drives, keyed by
 *  `binding.id` so the webhook can find it in one lookup. */
export interface GitBindingRecord {
  binding: GitBinding
  projectId: string
  branchId: string
  branchName: string
  group: string
}

/** The binding as a route may safely echo it: no token, no webhook secret. */
export function bindingOut(r: GitBindingRecord): Record<string, unknown> {
  return {
    id: r.binding.id, repo: `${r.binding.owner}/${r.binding.repo}`, ref: r.binding.ref,
    group: r.group, branch: r.branchName, private: r.binding.token !== '',
    lastDeployedSha: r.binding.lastDeployedSha ?? null, createdAt: r.binding.createdAt,
  }
}

const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const REF_RE = /^[A-Za-z0-9._/-]+$/

/** Parse an `owner/repo` (or a github.com URL) into its parts, or throw a 400-class Error. */
export function parseRepo(input: unknown): { owner: string; repo: string } {
  const s = typeof input === 'string' ? input.trim() : ''
  let slug = s
  const m = /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(s)
  if (m) slug = m[1]
  if (!OWNER_REPO_RE.test(slug)) throw new Error(`invalid repository ${JSON.stringify(input)}: expected owner/repo or a github.com URL`)
  const [owner, repo] = slug.split('/')
  return { owner, repo: repo.replace(/\.git$/, '') }
}

/** A branch/ref name safe to place in a git URL fragment. Defaults to `main`. */
export function normalizeRef(input: unknown): string {
  const s = typeof input === 'string' && input.trim() ? input.trim() : 'main'
  if (!REF_RE.test(s) || s.includes('..')) throw new Error(`invalid ref ${JSON.stringify(input)}`)
  return s
}

/** A fresh binding for a repo. The webhook secret is what GitHub signs the push with. */
export function newBinding(owner: string, repo: string, ref: string, token: string, now: number): GitBinding {
  return { id: randomUUID(), owner, repo, ref, token, webhookSecret: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), createdAt: new Date(now).toISOString() }
}

/** The BuildKit git-context URL. A token is sent as `x-access-token:<token>@` (HTTPS basic auth),
 *  the shape redactDockerArgs strips from logs; a public repo omits it. `fragment` is what BuildKit
 *  checks out: the pushed COMMIT SHA for a webhook (immutable, so an image labelled SHA A can never
 *  contain SHA B), or the branch ref for the initial connect build. */
export function buildContextUrl(b: Pick<GitBinding, 'owner' | 'repo' | 'token'>, fragment: string): string {
  // URL-encode the token so a malformed one (a stray '@', ':' or '/') cannot break out of the
  // userinfo component and defeat URL parsing or the redactor's `x-access-token:<...>@` match. Valid
  // GitHub PATs are unaffected (they encode to themselves).
  const auth = b.token ? `x-access-token:${encodeURIComponent(b.token)}@` : ''
  return `https://${auth}github.com/${b.owner}/${b.repo}.git#${fragment}`
}

/** The image tag a build produces: `io-git-<8 of binding id>-<8 of sha>` (or `-manual` with no sha). */
export function imageTag(bindingId: string, sha?: string): string {
  const clean = typeof sha === 'string' ? sha.replace(/[^a-f0-9]/gi, '').slice(0, 12) : ''
  const short = clean || 'manual'
  return `io-git-${bindingId.replace(/-/g, '').slice(0, 8)}:${short}`
}

/** Constant-time check of GitHub's `X-Hub-Signature-256: sha256=<hex>` over the RAW request body.
 *  A missing/malformed header or a mismatched length is false, never a throw. */
export function verifySignature(secret: string, rawBody: Buffer, header: unknown): boolean {
  if (typeof header !== 'string') return false
  const m = /^sha256=([a-f0-9]{64})$/i.exec(header.trim())
  if (!m) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  let got: Buffer
  try { got = Buffer.from(m[1], 'hex') } catch { return false }
  return got.length === expected.length && timingSafeEqual(got, expected)
}

/** The event + ref + head sha a GitHub push webhook carries, or null when the payload is not a push
 *  to a branch we can act on (a tag push, a delete, a ping, a malformed body). */
export function pushRef(event: unknown, body: unknown): { branch: string; sha: string } | null {
  if (event !== 'push') return null
  const b = (body ?? {}) as { ref?: unknown; after?: unknown; deleted?: unknown }
  if (b.deleted === true) return null
  if (typeof b.ref !== 'string' || !b.ref.startsWith('refs/heads/')) return null
  if (typeof b.after !== 'string' || /^0+$/.test(b.after)) return null
  return { branch: b.ref.slice('refs/heads/'.length), sha: b.after }
}
