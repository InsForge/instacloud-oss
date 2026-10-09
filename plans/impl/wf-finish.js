export const meta = {
  name: 'insta-oss-serverless-finish',
  description: 'Fix the verification findings, then run the Docker suites and the local smoke end to end on the assembled branch',
  phases: [
    { title: 'Fix', detail: 'apply the blockers and majors, then the minors' },
    { title: 'Docker', detail: 'the container suites, run serially with Docker up' },
    { title: 'Smoke', detail: 'drive the daemon like a user: deploy, branch, sleep, wake' },
  ],
}

const WT = '/Users/gary/projects/instacloud/insta-oss/.claude/worktrees/serverless'

const CONTEXT = [
  'Repo InsForge/insta-oss. You work directly in the INTEGRATION worktree ' + WT + ' on branch feat/single-node-serverless. All eight work packages are now merged: identity and config, router, scheduler, branching, templates and parity, packaging, dashboard, docs and e2e. The head passes typecheck, lint and 466 fake-adapter tests across 26 files, and the working tree is clean. No other agent writes here while you run.',
  '',
  'Docker IS running now (server 28.4.0), so container suites can execute.',
  '',
  'Read as needed: plans/impl/00-contract.md (types in 4, config in 3, state in 5, fakes in 6, engine hooks in 7.1 and 7.2, routes and cloud evidence in 9, section 10 for the credential and DSN forms, section 13 for the sleep and wake state machine), plans/impl/09-integration-order.md (the Docker sequence), and the package plans 01 to 08.',
  '',
  'COMMIT DISCIPLINE, NON-NEGOTIABLE: this session is interrupted by usage limits roughly every fifteen minutes and anything uncommitted is lost. Commit after EVERY fix and at minimum every few tool calls. Never hold more than one fix uncommitted. You are IN the worktree, so plain git commands work: no -C, no cd.',
  '',
  'KEEP THE TREE GREEN: 466 tests pass today. Never weaken or delete an assertion to make a change pass; fix the code instead. If a test legitimately must change because the contract says the behaviour is different, say so explicitly in your return value.',
  '',
  'Rules: no endpoint the cloud lacks; minimal dependencies; no competitor names in code or docs; no em dashes in docs copy; TypeScript strict. Every commit message ends with the line: Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>',
  '',
  'Return raw JSON only. If you run low on room, commit first, then return JSON saying exactly where you stopped and what remains in order.',
].join('\n')

phase('Fix')
const fixed = await agent(
  CONTEXT + '\n\nYou are the FIXER. The findings from three independent verifiers are in plans/impl/gap-findings.json: 2 blockers, 6 majors, 15 minors. Work them in that order of severity.'
    + '\n\nThe two blockers share one root cause: INSTA_OSS_RAM_FLOOR_PCT is validated as 1..90, but the contract decision and the shipped docs both say 0 disables pressure eviction, so the scheduler Docker suite and both public e2e scripts cannot even load. Fix it properly: accept 0 as the documented off switch, make evictForRoom and the pressure pass genuinely inert at 0, and make sure the docs, the suite and the two e2e scripts agree with the code.'
    + '\n\nThe majors, each with evidence in the file: the garage adapter detaches the shared container from a branch network when ONE per-service bucket is destroyed, which breaks S3 for every other bucket on that branch; the secrets bundle and the deploy env still emit the container-only Postgres DSN while contract section 10 requires one host-facing lane form across secrets, credentials and env (decide it deliberately, apply it consistently, and if that means editing merged router assertions, say so in your return value and do it); pressure eviction cannot observe the memory it just freed, so one pass sleeps every eligible service instead of the least recently active; and the sweep re-reads state per batch so a slow docker stop can sleep more than the rule intended.'
    + '\n\nThen apply the 15 minors, rejecting any whose evidence does not survive a read of the code, with a one-line reason. Run typecheck, lint and the full fake-adapter suite before your final commit. Do NOT run Docker suites: the next phase does.',
  { label: 'fix-findings', phase: 'Fix', effort: 'xhigh', schema: { type: 'object', properties: {
    headSha: { type: 'string' }, commits: { type: 'number' },
    applied: { type: 'array', items: { type: 'string' } },
    rejected: { type: 'array', items: { type: 'string' } },
    testEditsMade: { type: 'array', items: { type: 'string' }, description: 'existing assertions changed, with the contract justification for each' },
    tests: { type: 'string' }, remaining: { type: 'array', items: { type: 'string' } },
  }, required: ['headSha', 'commits', 'applied', 'rejected', 'testEditsMade', 'tests', 'remaining'] } }
)
log('fix: ' + (fixed ? fixed.applied.length + ' applied, ' + fixed.rejected.length + ' rejected, head ' + fixed.headSha : 'returned nothing'))

phase('Docker')
const docker = await agent(
  CONTEXT + '\n\nYou are the INTEGRATOR running the container suites. Docker is up. Follow the Docker test sequence in plans/impl/09-integration-order.md: run each suite ALONE with RUN_DOCKER_TESTS=1 npx vitest run <file>, in the listed order, with its own realpath temporary INSTA_OSS_DATA_DIR per file and INSTA_OSS_SCHEDULER=0 except for the sleep suite. Clean containers between files with a filter on the io- name prefix, and remove the garage volumes where the sequence says to.'
    + '\n\nFor every failure: diagnose it, fix the code rather than the test unless the test is provably wrong, re-run that suite until it passes, and commit each fix separately. Some suites pull images (the template suite pulls n8n) so allow generous timeouts. Report honestly: any suite you cannot get green must be listed as failing with its diagnosis, never described as passing. Note that these suites exercise real Postgres containers, reflink forks, bucket clones and the router lanes, so a failure here is a real defect in the product, not a test artefact.',
  { label: 'docker-suites', phase: 'Docker', effort: 'xhigh', schema: { type: 'object', properties: {
    headSha: { type: 'string' },
    passed: { type: 'array', items: { type: 'string' } },
    failed: { type: 'array', items: { type: 'object', properties: { suite: { type: 'string' }, diagnosis: { type: 'string' } }, required: ['suite', 'diagnosis'] } },
    skipped: { type: 'array', items: { type: 'string' } },
    fixes: { type: 'array', items: { type: 'string' } },
    realDefectsFound: { type: 'array', items: { type: 'string' } },
  }, required: ['headSha', 'passed', 'failed', 'skipped', 'fixes', 'realDefectsFound'] } }
)
log('docker: ' + (docker ? docker.passed.length + ' passed, ' + docker.failed.length + ' failed' : 'returned nothing'))

phase('Smoke')
const smoke = await agent(
  CONTEXT + '\n\nYou are the SMOKE TESTER, and you are the last honest check that this thing actually works. Drive the daemon the way a user would, in LOCAL mode on a spare port with a temporary data directory, and report what genuinely happened.'
    + '\n\nRun e2e/local-smoke.sh if it works; if it does not, do the same steps by hand with curl against the daemon and record both what you did and why the script could not run. The path to prove, end to end: boot the daemon; create a project; add a postgres service and a storage service; deploy a tiny public image as a compute service; reach it through the router hostname; read the database through the host-facing DSN with psql; create a branch and prove the fork carried the data and that writes do not leak back; let a service go idle and prove it actually stopped (docker ps shows exited, not paused); send one request and prove it woke and answered; deploy a bundled template and prove it comes up.'
    + '\n\nFor each step report PASS or FAIL with the evidence you observed, and for a FAIL give the diagnosis. Fix what you reasonably can, committing each fix, but do not paper over a failure: the value of this phase is an accurate picture. Clean up your containers and data directory at the end.',
  { label: 'local-smoke', phase: 'Smoke', effort: 'xhigh', schema: { type: 'object', properties: {
    headSha: { type: 'string' },
    steps: { type: 'array', items: { type: 'object', properties: { step: { type: 'string' }, result: { type: 'string', enum: ['pass', 'fail', 'skipped'] }, evidence: { type: 'string' } }, required: ['step', 'result', 'evidence'] } },
    fixes: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', description: 'does the single-node serverless story actually work today, and what is the honest gap list' },
  }, required: ['headSha', 'steps', 'fixes', 'verdict'] } }
)

return {
  fix: fixed ? { applied: fixed.applied.length, rejected: fixed.rejected, testEdits: fixed.testEditsMade, tests: fixed.tests, remaining: fixed.remaining } : null,
  docker: docker ? { passed: docker.passed, failed: docker.failed, skipped: docker.skipped, realDefects: docker.realDefectsFound } : null,
  smoke: smoke ? { steps: smoke.steps, verdict: smoke.verdict, fixes: smoke.fixes } : null,
}
