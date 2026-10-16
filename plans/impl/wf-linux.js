export const meta = {
  name: 'insta-oss-linux-verify',
  description: 'Prove the single-node serverless story on real Linux inside Docker-in-Docker, fix what breaks, then self-review the branch against the bot reviewers checklist',
  phases: [
    { title: 'Linux', detail: 'end to end inside a Linux Docker-in-Docker host' },
    { title: 'Installer', detail: 'install.sh on a clean Linux box' },
    { title: 'Self-review', detail: 'pre-empt the review bots' },
  ],
}

const WT = '/Users/gary/projects/instacloud/insta-oss/.claude/worktrees/serverless'

const CONTEXT = [
  'Repo InsForge/insta-oss. You work in ' + WT + ' on branch feat/single-node-serverless, which is pushed and open as draft PR #97. All eight work packages are merged. Head is green: typecheck, lint, 474 fake-adapter tests across 27 files, 7 container suites, and e2e/local-smoke.sh passing twice on this macOS laptop.',
  '',
  'THE PROBLEM YOU EXIST TO SOLVE: every one of those checks ran on macOS with APFS and the cp -c clone engine. Linux is the actual deployment target for this product, and it takes different code paths: the reflink call, host-gateway networking, bridge addressing, wildcard hostname resolution, filesystems without reflink support (overlayfs, ext4), and cgroup memory accounting for pressure eviction. The macOS run found four real product bugs. Assume Linux hides more, and go find them.',
  '',
  'Docker is running on this machine (server 28.4.0) but it is Docker Desktop on macOS, so the HOST is not Linux. Use a Docker-in-Docker container as your Linux host: run a privileged docker:dind (or a Linux image with a Docker daemon installed) with this repo mounted read-write, install Node 22 inside it, and drive everything from in there so the daemon, the containers it creates, and the filesystem are all genuinely Linux. Verify you are on Linux before trusting a result: uname -s inside your test host must say Linux.',
  '',
  'COMMIT DISCIPLINE: this session is interrupted by usage limits roughly every fifteen minutes and anything uncommitted is lost. Commit after every fix. You are IN the worktree so plain git commands work: no -C, no cd.',
  '',
  'KEEP THE TREE GREEN: 474 tests pass. Never weaken or delete an assertion to make something pass; fix the code. Re-run typecheck, lint and the fake suite before your final commit.',
  '',
  'Rules: no endpoint the cloud lacks; minimal dependencies; no competitor names in code or docs; no em dashes in docs copy; TypeScript strict. Every commit message ends with the line: Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>',
  '',
  'Return raw JSON only. Report honestly: a step you could not run is skipped with the reason, never described as passing. If you run low on room, commit first, then say exactly where you stopped.',
].join('\n')

phase('Linux')
const linux = await agent(
  CONTEXT + '\n\nYou are the LINUX VERIFIER. Stand up a Linux host as described and prove the product path end to end inside it, exactly as the macOS smoke did: boot the daemon in local mode; create a project and confirm it provisions nothing; add postgres and storage; deploy a small public image (traefik/whoami:v1.10 is known good) and reach it through the router hostname; read the database through the host-facing DSN with psql; create a branch and prove the fork carried the data, that writes do not leak back, and that the compute volume contents came with it; let compute and postgres go idle and prove they reach exited and not paused; wake each with one request or connect and record the milliseconds; prove a manual stop survives traffic; set a memory limit and read it back; deploy the bundled n8n template through the router; tear down and prove nothing is left behind.'
    + '\n\nPay special attention to the things that genuinely differ on Linux and record what actually happened for each: (1) the reflink probe, since the dind filesystem is likely overlayfs with no reflink support, so the fork MUST degrade to the documented fallback with a warning rather than failing or silently producing an empty volume, and pg forks must fall back to streaming basebackup; (2) how an app container reaches its own database, which on Linux depends on host-gateway rather than the macOS special hostname; (3) whether wildcard hostnames resolve, and whether the documented /etc/hosts fallback is needed; (4) free-memory measurement for pressure eviction, which inside a container must read the cgroup and not the host; (5) whether the daemon binds the addresses it expects. Fix every defect you find, commit each fix, and if a fix changes documented behaviour update the docs in the same commit.',
  { label: 'linux-e2e', phase: 'Linux', effort: 'xhigh', schema: { type: 'object', properties: {
    headSha: { type: 'string' },
    linuxHost: { type: 'string', description: 'how the Linux host was created and the uname output proving it is Linux' },
    steps: { type: 'array', items: { type: 'object', properties: { step: { type: 'string' }, result: { type: 'string', enum: ['pass', 'fail', 'skipped'] }, evidence: { type: 'string' } }, required: ['step', 'result', 'evidence'] } },
    linuxSpecificFindings: { type: 'array', items: { type: 'string' } },
    fixes: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string' },
  }, required: ['headSha', 'linuxHost', 'steps', 'linuxSpecificFindings', 'fixes', 'verdict'] } }
)
log('linux: ' + (linux ? linux.steps.filter(s => s.result === 'pass').length + '/' + linux.steps.length + ' steps pass, ' + linux.fixes.length + ' fixes' : 'returned nothing'))

phase('Installer')
const installer = await agent(
  CONTEXT + '\n\nYou are the INSTALLER VERIFIER. install.sh is 613 lines that no one has ever run on a real Linux box: it is the single most likely first contact a self-hosting user has with this product, and if it fails they never see anything else. Run it for real inside a clean Linux container that has systemd-free but working Docker (privileged docker:dind, or an Ubuntu 22.04 container with Docker installed), with the repo mounted so you can point it at the local tree instead of a published image where the script allows, and where it does not allow, note exactly what it would fetch.'
    + '\n\nProve or disprove, one by one: it refuses when 80, 443 or 5432 are busy; it installs or detects Docker; it creates the data directory and probes reflink, falling back gracefully on a filesystem without it; it detects an address and composes a default domain; it writes the compose file and env file with the data directory coming from its own env file and never the operator shell; it brings the stack up; it prints a setup URL that actually answers; re-running it upgrades rather than duplicating or wiping; and the documented uninstall or teardown path works. Also check it does not require a public IP to get that far, since a reviewer will try it on a laptop VM.'
    + '\n\nFix what breaks, commit each fix, and where the script cannot be fully exercised in a container (anything genuinely needing systemd, a public IP or a real certificate) say so explicitly and describe what remains unproven. Update docs/self-hosting/install.mdx in the same commit if reality differs from what it promises.',
  { label: 'installer', phase: 'Installer', effort: 'xhigh', schema: { type: 'object', properties: {
    headSha: { type: 'string' },
    checks: { type: 'array', items: { type: 'object', properties: { check: { type: 'string' }, result: { type: 'string', enum: ['pass', 'fail', 'skipped'] }, evidence: { type: 'string' } }, required: ['check', 'result', 'evidence'] } },
    fixes: { type: 'array', items: { type: 'string' } },
    unproven: { type: 'array', items: { type: 'string' } },
  }, required: ['headSha', 'checks', 'fixes', 'unproven'] } }
)
log('installer: ' + (installer ? installer.checks.filter(c => c.result === 'pass').length + '/' + installer.checks.length + ' checks pass' : 'returned nothing'))

phase('Self-review')
const review = await agent(
  CONTEXT + '\n\nYou are the PRE-EMPTIVE REVIEWER. Two review bots are about to read this branch and their findings cost a round trip each, so find what they would find first. Review the full diff of 906c6b6 to HEAD as a hostile senior reviewer would.'
    + '\n\nLook for exactly the things a careful reviewer flags: a route added that the cloud does not have, or one whose request or response shape drifts from the platform (check plans/impl/00-contract.md section 9 and the platform at /Users/gary/projects/insforge-repo/insta-platform); a credential, token or password written to a log, an error message or the state file in plaintext when it should not be; a shell command built from user input without quoting, especially in install.sh and anywhere the engine shells out to docker; a path traversal through a project, branch or service name that reaches the data directory; an unbounded read of a request body, a log or a docker output; a promise in README, COMPATIBILITY.md or the docs that the code does not keep; a test that asserts nothing or that was weakened; dead code and stray debug output; and any em dash in docs copy or competitor name anywhere.'
    + '\n\nFix everything you can justify from evidence, committing as you go, and list anything you deliberately left for a human. Then re-run typecheck, lint, the fake suite and build:ui, and finish with the working tree clean and everything pushed to the branch.',
  { label: 'self-review', phase: 'Self-review', effort: 'xhigh', schema: { type: 'object', properties: {
    headSha: { type: 'string' },
    fixed: { type: 'array', items: { type: 'string' } },
    leftForHuman: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' },
    pushed: { type: 'boolean' },
  }, required: ['headSha', 'fixed', 'leftForHuman', 'tests', 'pushed'] } }
)

return {
  linux: linux ? { host: linux.linuxHost, pass: linux.steps.filter(s => s.result === 'pass').length, fail: linux.steps.filter(s => s.result === 'fail').map(s => s.step + ': ' + s.evidence), skipped: linux.steps.filter(s => s.result === 'skipped').map(s => s.step), findings: linux.linuxSpecificFindings, fixes: linux.fixes, verdict: linux.verdict } : null,
  installer: installer ? { pass: installer.checks.filter(c => c.result === 'pass').length, fail: installer.checks.filter(c => c.result === 'fail').map(c => c.check + ': ' + c.evidence), fixes: installer.fixes, unproven: installer.unproven } : null,
  selfReview: review ? { fixed: review.fixed, leftForHuman: review.leftForHuman, tests: review.tests, pushed: review.pushed } : null,
}
