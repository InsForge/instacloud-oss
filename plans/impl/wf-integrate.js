export const meta = {
  name: 'insta-oss-serverless-integrate',
  description: 'Merge the package branches into feat/single-node-serverless in contract order, verifying after each merge, then run the Docker suites and fix what breaks',
  phases: [
    { title: 'Merge', detail: 'one agent merges the whole ladder, verifying at each step' },
  ],
}

const WT = '/Users/gary/projects/instacloud/insta-oss/.claude/worktrees/serverless'

const CONTEXT = [
  'Repo InsForge/insta-oss. You work in the INTEGRATION worktree ' + WT + ' on branch feat/single-node-serverless. This worktree is yours for this task; no other agent is writing to it.',
  '',
  'Read first: plans/impl/09-integration-order.md (the merge ladder, the per-merge verification, the Docker sequence, the conflict rules), plans/impl/00-contract.md (types, config, hooks, routes, region markers, ownership), and each package plan as you reach its merge.',
  '',
  'The package branches, all based on the scaffold commit 906c6b6, are in sibling worktrees under /Users/gary/projects/instacloud/insta-oss/.claude/worktrees/. Read each branch with plain git (log, show, diff) from this worktree; never edit a sibling worktree. Branch names and what each ACTUALLY contains, measured: wp1/identity-config-2 (1662 insertions: identity, config, state lock; its own tests were green in isolation), wp2/router-2 (3264: twelve src/router modules, engine hooks, domain routes), wp3/scheduler-2 (EMPTY, zero commits: the scheduler was never written; skip it and record it as not landed), wp4/branching-2 (1287: datadir, fsclone, migrate), wp5/templates-parity-2 (the yaml dependency ONLY, nothing else; merge it for the dependency and record the rest as not landed), wp6/packaging-2 (1221: Dockerfile, a 613-line install.sh, workflows), wp7/dashboard-2 (3805: pages and components), wp8/docs-e2e-2 (2247: six self-hosting pages, e2e scripts). Verify each with a log of 906c6b6 to that branch before merging.',
  '',
  'COMMIT DISCIPLINE: this session is interrupted by usage limits roughly every fifteen minutes and anything uncommitted is lost. Merge one branch at a time and commit the merge (plus any fixup) before starting the next. Never leave a conflicted or half-fixed tree between tool calls for longer than necessary. If you run out of room, stop at a committed state and report exactly where you are.',
  '',
  'Conflict rules are in 09 section "Conflict rules at merge": a conflict inside a region takes the region owner side and the other side is re-applied inside its own region; a conflict at a 7.2 edit point takes WP5 skeleton; a conflict in src/types.ts takes the contract text; a conflict in test/server.test.ts outside a region keeps the existing assertion unless the merging package plan lists that edit.',
  '',
  'Rules: no endpoint the cloud lacks; no competitor names in code or docs; no em dashes in docs copy; TypeScript strict. Every commit message ends with the line: Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>',
  '',
  'Return raw JSON only: your final message is consumed by a script.',
].join('\n')

phase('Merge')
const merged = await agent(
  CONTEXT + '\n\nYou are the INTEGRATOR. Work the merge ladder in this order, which is the 09-integration-order.md order minus the packages that did not land: WP1, WP5 (dependency only), WP4, WP2, WP6, WP7, WP8. WP3 is skipped entirely. IMPORTANT consequence of the missing scheduler: every scheduler-facing hook the scaffold left as an identity (withOp, wake, serviceKey, startAsleepFor, afterDeploy, sleepNewBranch, rowRuntime, healthOverlay, limitsFor, and the scheduler stub) must KEEP its scaffold identity body, and if the WP2 router calls a wake path that no scheduler provides, make that path proxy to a running container and answer a clear 503 for a sleeping one rather than crash. Likewise the WP5 template routes do not exist, so leave the templates surface exactly as the scaffold has it and do not invent one. For each branch: merge it into feat/single-node-serverless (no fast-forward, `git merge --no-ff <branch>`), resolve conflicts by the conflict rules, then run npm run typecheck, npm run lint and npm test and fix whatever the merge broke, then commit. Do NOT run Docker tests in this phase (a later phase does). After each merge also do that merge section\'s non-Docker verification steps from 09. If a branch is missing or so incomplete that merging it would break the tree beyond a quick fix, skip it, leave the tree green, and record it in notLanded with what is missing. Return JSON describing the final state.',
  { label: 'merge-ladder', phase: 'Merge', effort: 'xhigh', schema: { type: 'object', properties: {
    headSha: { type: 'string' },
    landed: { type: 'array', items: { type: 'string' } },
    notLanded: { type: 'array', items: { type: 'object', properties: { wp: { type: 'string' }, why: { type: 'string' } }, required: ['wp', 'why'] } },
    tests: { type: 'string' },
    conflictsResolved: { type: 'array', items: { type: 'string' } },
    brokenByMerge: { type: 'array', items: { type: 'string' } },
    remaining: { type: 'array', items: { type: 'string' } },
  }, required: ['headSha', 'landed', 'notLanded', 'tests', 'conflictsResolved', 'brokenByMerge', 'remaining'] } }
)
log('merge ladder: landed ' + ((merged && merged.landed) || []).join(', ') + ' | head ' + (merged ? merged.headSha : '?'))

return merged || { error: 'merge agent returned nothing; inspect the worktree for committed merges' }
