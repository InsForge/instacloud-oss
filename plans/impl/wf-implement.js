export const meta = {
  name: 'insta-oss-serverless-implement',
  description: 'Implement the 8 work packages in their existing per-package worktrees, committing incrementally so session interruptions never lose work',
  phases: [
    { title: 'Implement', detail: 'one implementer per package, resuming in place' },
  ],
}

const WT = '/Users/gary/projects/instacloud/insta-oss/.claude/worktrees/serverless'
const BASE = '906c6b6'
const HOME = '/Users/gary/projects/instacloud/insta-oss/.claude/worktrees'

const CONTEXT = [
  'Repo InsForge/insta-oss. The integration branch is feat/single-node-serverless in ' + WT + '; the scaffold commit every package builds on is ' + BASE + '.',
  '',
  'YOUR WORKTREE ALREADY EXISTS and may already contain substantial UNCOMMITTED work from an interrupted run. Do not create a new worktree. cd to the path given below and work there for the whole task.',
  '',
  'STEP ZERO, BEFORE READING ANYTHING ELSE: run `git status --short` in your worktree. If anything is uncommitted, run `git add -A` and commit it immediately with the message "wip: recovered from interrupted run" (append the Co-Authored-By line). Do this even if the code is incomplete or does not compile: an unreviewed commit is recoverable, an uncommitted file is not. Only after that commit exists do you start reading and working.',
  '',
  'COMMIT DISCIPLINE, NON-NEGOTIABLE: this session gets interrupted by usage limits roughly every fifteen minutes, and anything uncommitted at that moment is lost. Commit after EVERY file you finish, and at minimum every few tool calls. Never hold more than one file of work uncommitted. A broken intermediate commit is fine and expected; you or a later run will fix it forward. Do not batch work up for a single tidy commit at the end, because that commit will never happen.',
  '',
  'Read, in order: plans/2026-09-08-single-node-serverless-spec.md (the design), plans/impl/00-contract.md (the integration contract: types, config, engine hooks, routes, region markers, ownership rules in 1.2 and 1.3), plans/impl/09-integration-order.md, then YOUR package plan. Other package plans are context only. If a previous run left work in place, read it first and verify it against the plan: keep what is right, fix what is wrong, and continue from there rather than starting over.',
  '',
  'OWNERSHIP IS STRICT: edit only the files your plan owns, and inside shared files (src/engine.ts, src/server.ts, src/types.ts, src/state.ts, src/main.ts, src/manageddb.ts, test/server.test.ts, test/fakes.ts, ui/src/api.ts, .github/workflows/ci.yml) write only inside YOUR region markers or at the 7.2 edit points your plan names. A hook body you own replaces the identity the scaffold left in your region. If you need a contract change, record it in your return value under contractChangesNeeded and do the smallest local thing that keeps you unblocked; never edit another package region.',
  '',
  'Tests: the fake-adapter suites are the contract suite and must stay green: npm run typecheck, npm run lint, npm test (int tests are excluded unless RUN_DOCKER_TESTS=1). Add the tests your plan lists. Do NOT run Docker integration tests (*.int.test.ts) and do NOT start containers: other implementers run concurrently and container names collide. You may write new *.int.test.ts files for the integrator to run.',
  '',
  'Rules: no endpoint the cloud lacks (every route must appear in contract section 9 with cloud evidence); minimal dependencies (yaml@^2 is the only pre-approved addition, WP5 only); no competitor names in code or docs; no em dashes in docs copy; TypeScript strict. Every commit message ends with the line: Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>',
  '',
  'Return raw JSON only: your final message is consumed by a script. If you are running out of room, commit first, then return your JSON describing exactly where you stopped.',
].join('\n')

const WPS = [
  { n: 1, slug: 'identity-config', plan: 'plans/impl/01-identity-config.md', dir: HOME + '/wf_e142fad4-519-1', branch: 'wp1/identity-config-2' },
  { n: 2, slug: 'router', plan: 'plans/impl/02-router.md', dir: HOME + '/wf_e142fad4-519-2', branch: 'wp2/router-2' },
  { n: 3, slug: 'scheduler', plan: 'plans/impl/03-scheduler.md', dir: HOME + '/wf_e142fad4-519-3', branch: 'wp3/scheduler-2' },
  { n: 4, slug: 'branching', plan: 'plans/impl/04-branching.md', dir: HOME + '/wf_e142fad4-519-4', branch: 'wp4/branching-2' },
  { n: 5, slug: 'templates-parity', plan: 'plans/impl/05-templates-parity.md', dir: HOME + '/wf_e142fad4-519-5', branch: 'wp5/templates-parity-2' },
  { n: 6, slug: 'packaging', plan: 'plans/impl/06-packaging.md', dir: HOME + '/wf_e142fad4-519-6', branch: 'wp6/packaging-2' },
  { n: 7, slug: 'dashboard', plan: 'plans/impl/07-dashboard.md', dir: HOME + '/wf_e142fad4-519-7', branch: 'wp7/dashboard-2' },
  { n: 8, slug: 'docs-e2e', plan: 'plans/impl/08-docs-e2e.md', dir: HOME + '/wf_e142fad4-519-8', branch: 'wp8/docs-e2e-2' },
]

const IMPL_SCHEMA = { type: 'object', properties: {
  headSha: { type: 'string' },
  commits: { type: 'number' },
  filesChanged: { type: 'array', items: { type: 'string' } },
  tests: { type: 'string', description: 'typecheck/lint/npm test results with counts, or why they were not run' },
  doneWhen: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, status: { type: 'string', enum: ['done', 'partial', 'not-done'] }, note: { type: 'string' } }, required: ['item', 'status'] } },
  remaining: { type: 'array', items: { type: 'string' }, description: 'exactly what a later run must still do, in order' },
  contractChangesNeeded: { type: 'array', items: { type: 'string' } },
  dockerTestsForIntegrator: { type: 'array', items: { type: 'string' } },
  notes: { type: 'array', items: { type: 'string' } },
}, required: ['headSha', 'commits', 'filesChanged', 'tests', 'doneWhen', 'remaining', 'contractChangesNeeded', 'dockerTestsForIntegrator', 'notes'] }

phase('Implement')
const results = await parallel(WPS.map(w => () => agent(
  CONTEXT + '\n\nYou are the IMPLEMENTER of WP' + w.n + ' (' + w.slug + ').'
    + '\nYour worktree: ' + w.dir + '   (cd there first; it is yours alone)'
    + '\nYour branch: ' + w.branch + '   (already checked out)'
    + '\nYour plan: ' + w.plan
    + '\n\nDo step zero (commit any uncommitted work), then implement the plan completely: every file, every algorithm step, every listed test, until every item of its Done-when checklist is done or you have a concrete reason it cannot be. Commit continuously as instructed. Before returning, run npm run typecheck, npm run lint and npm test, fix what you broke, commit, then re-read the Done-when list and grade each item honestly.',
  { label: 'impl:wp' + w.n + '-' + w.slug, phase: 'Implement', schema: IMPL_SCHEMA, effort: 'high' }
)))

return WPS.map((w, i) => {
  const r = results[i]
  if (!r) return { wp: w.n, slug: w.slug, dir: w.dir, branch: w.branch, status: 'agent died, check worktree for commits' }
  return {
    wp: w.n, slug: w.slug, dir: w.dir, branch: w.branch,
    headSha: r.headSha, commits: r.commits,
    done: r.doneWhen.filter(d => d.status === 'done').length + '/' + r.doneWhen.length,
    notDone: r.doneWhen.filter(d => d.status !== 'done').map(d => d.item + ': ' + (d.note || d.status)),
    remaining: r.remaining, tests: r.tests,
    contractChangesNeeded: r.contractChangesNeeded, dockerTests: r.dockerTestsForIntegrator, notes: r.notes,
  }
})
