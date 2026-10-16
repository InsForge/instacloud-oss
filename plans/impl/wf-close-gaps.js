export const meta = {
  name: 'insta-oss-close-gaps',
  description: 'Write the three missing container suites, then close the small findings and correct the docs',
  phases: [
    { title: 'Suites', detail: 'the three container suites the integration order names but nobody wrote' },
    { title: 'Findings', detail: 'the small defects and doc corrections from both VPS runs' },
  ],
}

const WT = '/Users/gary/projects/instacloud/insta-oss/.claude/worktrees/serverless'

const CONTEXT = [
  'Repo InsForge/insta-oss, branch feat/single-node-serverless, draft PR #97. You work in ' + WT + ' with plain git (no -C, no cd outside it).',
  '',
  'CONCURRENCY WARNING: another agent may be testing on a live EC2 box and committing to this same worktree. Before editing a file, re-read it. Commit after every change so your work cannot be lost, and if you find an edit of yours gone, re-apply it. Never use git reset, git rebase, git checkout of a whole path, or force anything: that destroys another agent work.',
  '',
  'COMMIT DISCIPLINE, NON-NEGOTIABLE: this session is interrupted by usage limits roughly every fifteen to twenty minutes and anything uncommitted at that moment is lost. Commit after every file you finish. Three previous waves lost hours of work this way. A broken intermediate commit is fine; an uncommitted one is not.',
  '',
  'STATE: all eight work packages are merged. The tree is green at 517 tests across 30 files. Three real environments have already been exercised (a t3.small Ubuntu VPS, a Docker-in-Docker Linux host, and this macOS laptop) and roughly fifteen real defects plus five security issues are fixed. The arm64 template gap is closed. Read plans/impl/00-contract.md, plans/impl/09-integration-order.md, plans/2026-09-08-single-node-serverless-spec.md, COMPATIBILITY.md and the docs/self-hosting pages.',
  '',
  'KEEP THE TREE GREEN: run npm run typecheck, npm run lint and npm test before each commit where practical and always before your last. Never weaken or delete an assertion to make something pass.',
  '',
  'Rules: no endpoint the cloud lacks; minimal dependencies; no competitor names in code or docs; no em dashes in docs copy; TypeScript strict. Every commit message ends with the line: Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>',
  '',
  'Return raw JSON only. Report honestly: anything you could not verify is listed as unverified, never as done.',
].join('\n')

phase('Suites')
const suites = await agent(
  CONTEXT + '\n\nYou are writing THE THREE CONTAINER SUITES that plans/impl/09-integration-order.md names in its Docker sequence but nobody ever wrote. They are an open gap on the PR, and each covers a path that only real Docker exercises. Docker is running on this machine (arm64 macOS, APFS, so reflinks ARE available here).'
    + '\n\n1. test/fork.int.test.ts: the Postgres fork, run in both modes, INSTA_OSS_FORK=auto (which takes the reflink path on this APFS laptop) and INSTA_OSS_FORK=basebackup. Assert the recorded method matches the mode, the fork carries seeded data, writes on the fork never reach the parent, and the parent is untouched. Also assert the strict mode, INSTA_OSS_FORK=reflink, refuses rather than silently copying when reflinks are unavailable, which nothing has ever covered.'
    + '\n2. test/datadir-migrate.int.test.ts: a real pre-scaffold data directory with legacy named volumes and old container names, migrated by src/datadir-migrate.ts. Build the legacy shape for real, run the migration, assert the data survives, the services still start, and re-running is a no-op.'
    + '\n3. test/router.int.test.ts: the router lanes against real containers, today covered only by fake suites even though test/template-deploy.int.test.ts says this suite is what covers the HTTP lane it bypasses. Assert Host-based routing to a real container, hold-and-wake on a sleeping service, the pg-wire lane end to end with a real psql client through SNI, that a user-stopped service answers a clear error rather than waking, and that nothing is published beyond loopback.'
    + '\n\nRun each suite yourself with RUN_DOCKER_TESTS=1, one at a time, cleaning containers between runs. If a suite finds a real defect, fix the code rather than softening the test, and commit the fix separately from the test. These must be runnable in CI on a Linux runner, so where behaviour differs by platform branch on the detected capability rather than skipping.',
  { label: 'suites', phase: 'Suites', effort: 'xhigh', schema: { type: 'object', properties: {
    headSha: { type: 'string' },
    suites: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, tests: { type: 'number' }, result: { type: 'string', enum: ['green', 'red', 'not-written'] }, notes: { type: 'string' } }, required: ['file', 'tests', 'result', 'notes'] } },
    defectsFound: { type: 'array', items: { type: 'string' } },
    unverified: { type: 'array', items: { type: 'string' } },
  }, required: ['headSha', 'suites', 'defectsFound', 'unverified'] } }
)
log('suites: ' + (suites ? suites.suites.filter(s => s.result === 'green').length + '/3 green, ' + suites.defectsFound.length + ' defects' : 'returned nothing'))

phase('Findings')
const findings = await agent(
  CONTEXT + '\n\nYou are closing the SMALL FINDINGS two VPS runs left behind. Each is small alone; together they are the difference between a branch that works and one a stranger trusts. Verify each against the code before changing anything, and reject with a reason any whose evidence no longer holds, since about fifteen fixes have landed since they were written.'
    + '\n\nFrom the EC2 run: (a) a successful install prints a scary warning that the edge has not issued a certificate, because its wait is shorter than a first ACME issuance, so a healthy install looks broken; (b) the documented 2 GiB RAM and 15 GiB disk minimums are never checked by install.sh; (c) on a public box with an auto domain, certificate transparency publishes every hostname within minutes and internet scanners then wake services, so an operator watching docker ps concludes scale-to-zero is broken. That last one needs an honest paragraph in docs/self-hosting/sleep.mdx, because it is real behaviour rather than a bug, and it was measured: a control service that never got a public certificate slept exactly on schedule twice while public ones were woken by unsolicited traffic.'
    + '\n\nFrom the Linux run: (d) e2e/server-smoke.sh still dirties the operator checkout the way local-smoke.sh did before it was fixed, because it creates a project from the caller cwd and writes its log into the repo. Fix it the same way.'
    + '\n\nThen do a final pass over README.md, COMPATIBILITY.md and every docs/self-hosting page, checking each concrete claim against the code as it now stands, and correct whatever drifted. Pay attention to numbers, defaults, command names and anything describing behaviour the recent fixes changed. Finish with typecheck, lint, the full fake suite and build:ui green, the working tree clean of source changes, and everything pushed to the branch.',
  { label: 'findings', phase: 'Findings', effort: 'xhigh', schema: { type: 'object', properties: {
    headSha: { type: 'string' },
    fixed: { type: 'array', items: { type: 'string' } },
    rejected: { type: 'array', items: { type: 'string' } },
    docClaimsCorrected: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' },
    pushed: { type: 'boolean' },
  }, required: ['headSha', 'fixed', 'rejected', 'docClaimsCorrected', 'tests', 'pushed'] } }
)

return {
  suites: suites ? { suites: suites.suites, defects: suites.defectsFound, unverified: suites.unverified } : null,
  findings: findings ? { fixed: findings.fixed, rejected: findings.rejected, docs: findings.docClaimsCorrected, tests: findings.tests, pushed: findings.pushed } : null,
}
