export const meta = {
  name: 'insta-oss-serverless-scaffold',
  description: 'Step 0 scaffold commit on feat/single-node-serverless: config, final types, adapter adaptation, hook skeleton, region markers, fakes extraction; verified by independent checkers',
  phases: [
    { title: 'Scaffold', detail: 'one agent implements 09 step 0 and commits' },
    { title: 'Check', detail: 'independent verification against the contract' },
    { title: 'Fix', detail: 'scaffolder applies verified findings' },
  ],
}
const WT = '/Users/gary/projects/instacloud/insta-oss/.claude/worktrees/serverless'
const CONTEXT = [
  'Repo InsForge/insta-oss, checkout ' + WT + ', branch feat/single-node-serverless at 31170a2. Work ONLY in this directory.',
  'Read first: plans/impl/00-contract.md (sections 1.1 scaffold, 1.2 ownership, 1.3 region markers, 3 Config, 4 types, 5 state, 6 test fakes, 7.1/7.2 engine hooks and edit points), then plans/impl/09-integration-order.md step 0 (the exact scaffold task list, items 1-7). Package plans 01-08 are context only.',
  'Fixed rules: no behaviour change (today npm run dev output byte-identical; all existing fake-adapter tests green with only the assertion edits listed in 09 step 0 item 4); no new dependencies in the scaffold; TypeScript strict and eslint clean; commit messages end with the line: Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>',
  'Do NOT run Docker integration tests (*.int.test.ts) unless the task says so. Fake-adapter tests: npx vitest run test/server.test.ts test/restart-policy.test.ts plus any new non-Docker test files.',
  'Return raw JSON only; your final message is consumed by a script.',
].join('\n')

phase('Scaffold')
const built = await agent(
  CONTEXT + '\n\nYou are the SCAFFOLDER (integrator role). A previous attempt was interrupted midway: the worktree has UNCOMMITTED partial scaffold work (git status shows modified .github/workflows/ci.yml, src/adapters/{compute,manageddb,postgres}.ts, src/govern.ts, src/main.ts, src/manageddb.ts, src/state.ts, src/types.ts, ui/src/api.ts, vitest.config.ts and new src/config.ts, test/config.test.ts, test/fakes.ts; src/engine.ts, src/server.ts and test/server.test.ts are untouched). Start by reading git diff and the new files, verify each against the contract, keep what is correct, fix what is not, then complete the rest. Implement 09-integration-order.md step 0 completely: item 1 (src/config.ts + test/config.test.ts), item 2 (src/types.ts verbatim from contract section 4; govern DEFAULTS gains service.upgrade), item 3 (mechanical adapter adaptation with today\'s semantics), 3b (every engine hook identity in its owner region, deployLocked assembling the 7.2 argument object through them), 3c (main.ts boot skeleton with all region markers in final order; state.ts final export list with today\'s bodies and stubs), 3d (server.ts API_PREFIXES export and the stub moves into regions A/B/C), item 4 (test/fakes.ts extraction; server.test.ts imports it; the 501 sweep split; ONLY the listed assertion edits), item 5 (region markers in every listed file including ui/src/api.ts and ci.yml anchors), item 6 (vitest excludes *.int.test.ts unless RUN_DOCKER_TESTS; ci.yml sets RUN_DOCKER_TESTS=1 INSTA_OSS_SCHEDULER=0), item 7 verification EXCEPT the Docker suites: run npm run typecheck, npm run lint, npm test, and confirm that running npx tsx src/main.ts --port 18099 prints today\'s startup lines, then kill it. Then run exactly ONE Docker suite to prove the interim fork path: RUN_DOCKER_TESTS=1 npx vitest run test/clone-isolation.int.test.ts (before and after: docker ps -aq --filter name=io-citest | xargs docker rm -f). Commit as one commit titled: scaffold: config, final types, adapter adaptation, hook skeleton, region markers (09 step 0). Return JSON: commit sha, files changed, test counts, any deviation from the contract you had to make and why.',
  { label: 'scaffold', phase: 'Scaffold', effort: 'xhigh', schema: { type: 'object', properties: { sha: { type: 'string' }, filesChanged: { type: 'array', items: { type: 'string' } }, tests: { type: 'string' }, deviations: { type: 'array', items: { type: 'string' } } }, required: ['sha', 'filesChanged', 'tests', 'deviations'] } }
)
log('scaffold committed ' + (built && built.sha ? built.sha : '?') + '; files ' + (built && built.filesChanged ? built.filesChanged.length : 0) + '; deviations ' + (built && built.deviations ? built.deviations.length : 0))

phase('Check')
const CHECKS = [
  { key: 'contract-diff', prompt: 'Compare the scaffold commit (HEAD) against 00-contract.md sections 3, 4, 5, 6, 7.1, 7.2, 1.1 and 1.3 and against 09 step 0 line by line. Is src/types.ts verbatim section 4? Does every hook in 1.1/7.1 exist as an identity in the right owner region with the documented scaffold body? Are ALL region markers present in every listed file with the exact marker text the package plans grep for (grep each of plans/impl/01..08 for its own marker strings and confirm each exists)? Does deployLocked assemble the 7.2 argument object? Is test/fakes.ts per section 6? Are the API_PREFIXES lines and the three stub moves present? Does vitest exclude int tests without RUN_DOCKER_TESTS? Is ci.yml updated?' },
  { key: 'behaviour', prompt: 'Prove no behaviour change. Read git diff 31170a2..HEAD -- src/ and reason about every changed code path. Diff test/server.test.ts against 31170a2 and list every changed assertion; confirm they are exactly the edits listed in 09 step 0 item 4 and nothing else. Run npm run typecheck, npm run lint and npm test yourself. Read src/main.ts at 31170a2 (git show 31170a2:src/main.ts) to know the original startup lines, boot npx tsx src/main.ts --port 18098 for a few seconds, compare its stdout, then kill it. Do NOT run Docker tests.' },
]
const findings = (await parallel(CHECKS.map(c => () => agent(
  CONTEXT + '\n\nYou are an independent CHECKER of the scaffold commit (HEAD). ' + c.prompt + '\n\nReturn only concrete findings with file:line evidence and the exact fix; no padding.',
  { label: 'check:' + c.key, phase: 'Check', effort: 'high', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { problem: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'major', 'minor'] } }, required: ['problem', 'evidence', 'fix', 'severity'] } } }, required: ['findings'] } }
)))).filter(Boolean).flatMap(r => r.findings)
log(findings.length + ' scaffold findings')

phase('Fix')
let fixed = { applied: [], rejected: [], sha: built && built.sha ? built.sha : '' }
if (findings.length) {
  const r = await agent(
    CONTEXT + '\n\nYou are the SCAFFOLDER again. Apply these verified findings to the scaffold in a second commit titled: scaffold: checker fixes. Reject any finding with a one-line reason if, after verifying, its evidence is wrong. Re-run npm run typecheck, npm run lint, npm test. Return JSON.\n\nFINDINGS:\n' + JSON.stringify(findings, null, 1),
    { label: 'fix', phase: 'Fix', effort: 'high', schema: { type: 'object', properties: { applied: { type: 'array', items: { type: 'string' } }, rejected: { type: 'array', items: { type: 'string' } }, sha: { type: 'string' } }, required: ['applied', 'rejected', 'sha'] } }
  )
  if (r) fixed = r
}
return { scaffoldSha: built ? built.sha : null, finalSha: fixed.sha, files: built && built.filesChanged ? built.filesChanged.length : 0, tests: built ? built.tests : null, deviations: built ? built.deviations : [], findings: findings.length, applied: fixed.applied ? fixed.applied.length : 0, rejected: fixed.rejected || [] }