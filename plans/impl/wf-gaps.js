export const meta = {
  name: 'insta-oss-serverless-gaps',
  description: 'Build the two packages that never landed, templates/parity then the scheduler, directly on the integration branch',
  phases: [
    { title: 'Templates', detail: 'WP5: catalog, template deploy, project parity' },
    { title: 'Scheduler', detail: 'WP3: sleep, wake, eviction, limits, always-on' },
    { title: 'Verify', detail: 'independent check of both packages' },
  ],
}

const WT = '/Users/gary/projects/instacloud/insta-oss/.claude/worktrees/serverless'

const CONTEXT = [
  'Repo InsForge/insta-oss. You work directly in the INTEGRATION worktree ' + WT + ' on branch feat/single-node-serverless, which now has six of the eight packages merged (identity and config, router, branching, packaging, dashboard, docs and e2e). Its head passes typecheck, lint and 369 fake-adapter tests across 23 files. No other agent is writing to this worktree while you run.',
  '',
  'Read first: plans/impl/00-contract.md (the integration contract: types in section 4, config in 3, state in 5, test fakes in 6, engine hooks and edit points in 7.1 and 7.2, routes with cloud evidence in 9, region markers in 1.3), plans/impl/09-integration-order.md, then YOUR package plan. Read the already-merged code before writing: the scaffold left your hooks as identity functions inside your own region markers, and your job is to replace those bodies.',
  '',
  'COMMIT DISCIPLINE, NON-NEGOTIABLE: this session is interrupted by usage limits roughly every fifteen minutes and anything uncommitted at that moment is lost. Commit after EVERY file you finish and at minimum every few tool calls. Never hold more than one file of work uncommitted. A broken intermediate commit is fine and expected. Do not batch work for one tidy commit at the end, because that commit will not happen. You are IN the worktree, so plain git commands work: run them without -C and without cd.',
  '',
  'KEEP THE TREE GREEN: the six merged packages are working code and 369 passing tests. Never weaken or delete an existing assertion to make your change pass. If an existing test legitimately must change because your package redefines the behaviour, your plan must list that edit; otherwise fix your code instead. Run npm run typecheck, npm run lint and npm test before each commit where practical, and always before your last.',
  '',
  'Do NOT run Docker integration tests (*.int.test.ts) and do NOT start containers: Docker may be unavailable and the integrator runs those suites later. You may write new *.int.test.ts files for the integrator.',
  '',
  'Rules: no endpoint the cloud lacks (every route must appear in contract section 9 with its cloud evidence; verify against /Users/gary/projects/insforge-repo/insta-platform origin/main when unsure); minimal dependencies (yaml is already installed for the catalog); no competitor names in code or docs; no em dashes in docs copy; TypeScript strict. Every commit message ends with the line: Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>',
  '',
  'Return raw JSON only: your final message is consumed by a script. If you run low on room, commit first, then return JSON saying exactly where you stopped and what remains in order.',
].join('\n')

const SCHEMA = { type: 'object', properties: {
  headSha: { type: 'string' },
  commits: { type: 'number' },
  filesChanged: { type: 'array', items: { type: 'string' } },
  tests: { type: 'string', description: 'typecheck, lint and npm test results with counts' },
  doneWhen: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, status: { type: 'string', enum: ['done', 'partial', 'not-done'] }, note: { type: 'string' } }, required: ['item', 'status'] } },
  remaining: { type: 'array', items: { type: 'string' } },
  contractDeviations: { type: 'array', items: { type: 'string' } },
  dockerTestsForIntegrator: { type: 'array', items: { type: 'string' } },
  notes: { type: 'array', items: { type: 'string' } },
}, required: ['headSha', 'commits', 'filesChanged', 'tests', 'doneWhen', 'remaining', 'contractDeviations', 'dockerTestsForIntegrator', 'notes'] }

phase('Templates')
const wp5 = await agent(
  CONTEXT + '\n\nYou are the IMPLEMENTER of WP5 (templates and project parity), plan plans/impl/05-templates-parity.md. You go FIRST because your structural rewrite of provisionBranch, createBranch and services underpins the scheduler that follows you.'
    + '\n\nWhat exists: only the yaml dependency. Everything else in plan 05 has to be written: src/templates/manifest.ts, catalog.ts and executor.ts; the per-service bucket rewrite in the garage adapter; test/templates.test.ts; test/template-deploy.int.test.ts (write it, do not run it); the engine structural rewrite of provisionBranch, createBranch and services; server region D; state templateDeployments and migrateState; manageddb parseServiceId and CANONICAL_KEYS; and the 7.2 edit points (resources: [] on project create, the services add postgres and storage block, resolveSid, ?group= on the database routes, the {teardown} DELETE bodies).'
    + '\n\nTwo cautions from the merge. First, the router is already merged and reads service rows and hostnames, so when you change the shape of a services() row or a service id, grep src/router and ui/src for readers and keep them working. Second, the scheduler does NOT exist yet: its hooks (withOp, wake, serviceKey, startAsleepFor, afterDeploy, sleepNewBranch, rowRuntime, healthOverlay, limitsFor and the scheduler stub) are still scaffold identities, so call them exactly as the contract specifies and let them stay identities. Implement your plan completely, grade every Done-when item honestly, and commit continuously.',
  { label: 'wp5-templates', phase: 'Templates', schema: SCHEMA, effort: 'xhigh' }
)
log('WP5: ' + (wp5 ? wp5.commits + ' commits, ' + wp5.doneWhen.filter(d => d.status === 'done').length + '/' + wp5.doneWhen.length + ' done, head ' + wp5.headSha : 'returned nothing'))

phase('Scheduler')
const wp3 = await agent(
  CONTEXT + '\n\nYou are the IMPLEMENTER of WP3 (the scheduler: sleep, wake, eviction, limits, always-on), plan plans/impl/03-scheduler.md. You go SECOND, after the templates package, and you are the heart of the single-node serverless promise: without you nothing ever sleeps or wakes.'
    + '\n\nWhat exists: nothing of your package. Everything in plan 03 has to be written: src/scheduler.ts and src/upstream.ts; test/scheduler.test.ts, test/upstream.test.ts and test/sleep-wake.int.test.ts (write the int test, do not run it); the engine region WP3 hook bodies replacing the scaffold identities (withOp with its per-ServiceKey operation lock and AsyncLocalStorage re-entrancy, serviceKey, wake with singleflight, startAsleepFor, afterDeploy, sleepNewBranch, rowRuntime, healthOverlay, limitsFor and the real scheduler in place of the no-op stub); server region C (the limits and always-on routes, replacing their 501 stubs); the PATCH database/settings parse for scaleToZero, idleTimeout, cpu and memory; the observability code path that answers 503 for a sleeping database instead of waking it; the ComputeAdapter.state deletion; and the args WP3 limit lines in the three adapters.'
    + '\n\nThe router is already merged and is your main caller: read src/router/wake.ts, src/router/deps.ts and src/router/index.ts first and wire yourself to what they already expect, rather than changing their interface. Today they fall back to a Docker CLI upstream that returns no address for a stopped container and answers 503; once you land, a stopped-but-not-user-stopped service must actually wake and be proxied. Sleep is docker stop with a SIGTERM grace, never docker pause as the primary. Honour the contract state machine and the four wake doors, and never wake a user-stopped service on traffic. Implement your plan completely, grade every Done-when item honestly, and commit continuously.',
  { label: 'wp3-scheduler', phase: 'Scheduler', schema: SCHEMA, effort: 'xhigh' }
)
log('WP3: ' + (wp3 ? wp3.commits + ' commits, ' + wp3.doneWhen.filter(d => d.status === 'done').length + '/' + wp3.doneWhen.length + ' done, head ' + wp3.headSha : 'returned nothing'))

phase('Verify')
const CHECKS = [
  { key: 'wp5', prompt: 'Verify the templates and project parity package (WP5) against plans/impl/05-templates-parity.md and 00-contract.md. Every Done-when item: really done? Every route: in contract section 9 with the documented shape, and nothing invented that the cloud lacks (check the template routes against /Users/gary/projects/insforge-repo/insta-platform origin/main openapi.yaml and src/server.ts, and against how the CLI calls them in /Users/gary/projects/insforge-repo/insta-cli src/commands/template.ts)? Manifest parsing, generated secrets and the interpolation of service URLs and managed-db keys: read the code and try to break it with a hostile manifest. Did the service-id or services-row change break any reader in src/router or ui/src?' },
  { key: 'wp3', prompt: 'Verify the scheduler package (WP3) against plans/impl/03-scheduler.md and 00-contract.md. Every Done-when item: really done? Attack the concurrency: the per-ServiceKey operation lock against a concurrent deploy, lifecycle call, sweep and traffic wake; re-entrancy through AsyncLocalStorage; singleflight; whether a sleep can race a wake into a state where the row lies about the container; leaked timers or intervals; eviction thrash; the create grace; and whether a user-stopped service can be woken by traffic. Check sleep is docker stop with a grace and not pause, and that the four wake doors are exactly the contract set.' },
  { key: 'regression', prompt: 'Hunt for regressions across the whole branch after both packages landed. Run npm run typecheck, npm run lint, npm test and npm run build:ui. Diff test/server.test.ts against the merge commit 8a41ec8 and list every assertion that was changed, weakened or deleted, and say for each whether the owning plan authorises that edit. Confirm local mode still behaves as it does today (no auth, localhost, the same three startup lines) by reading the boot path. Confirm nothing in COMPATIBILITY.md or the self-hosting docs is now false.' },
]
const findings = (await parallel(CHECKS.map(c => () => agent(
  CONTEXT + '\n\nYou are an independent VERIFIER (read-only: run tests and read code, but do not edit or commit, and do not run Docker tests). ' + c.prompt + '\n\nReturn concrete findings with file:line evidence and the exact fix. Report a finding only when you can point at the evidence; do not pad.',
  { label: 'verify:' + c.key, phase: 'Verify', effort: 'high', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { problem: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'major', 'minor'] } }, required: ['problem', 'evidence', 'fix', 'severity'] } } }, required: ['findings'] } }
)))).filter(Boolean).flatMap(r => r.findings)
log(findings.length + ' verification findings (' + findings.filter(f => f.severity === 'blocker').length + ' blockers)')

return {
  wp5: wp5 ? { commits: wp5.commits, done: wp5.doneWhen.filter(d => d.status === 'done').length + '/' + wp5.doneWhen.length, notDone: wp5.doneWhen.filter(d => d.status !== 'done').map(d => d.item + ': ' + (d.note || d.status)), remaining: wp5.remaining, tests: wp5.tests, deviations: wp5.contractDeviations, dockerTests: wp5.dockerTestsForIntegrator } : null,
  wp3: wp3 ? { commits: wp3.commits, done: wp3.doneWhen.filter(d => d.status === 'done').length + '/' + wp3.doneWhen.length, notDone: wp3.doneWhen.filter(d => d.status !== 'done').map(d => d.item + ': ' + (d.note || d.status)), remaining: wp3.remaining, tests: wp3.tests, deviations: wp3.contractDeviations, dockerTests: wp3.dockerTestsForIntegrator } : null,
  findings: findings,
}
