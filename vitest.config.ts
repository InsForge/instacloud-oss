import { configDefaults, defineConfig } from 'vitest/config'
// forks: each test file gets its own process so state-path overrides don't bleed.
// generous timeouts: integration tests start real Docker containers.
// Docker suites (test/**/*.int.test.ts) run only with RUN_DOCKER_TESTS=1 (CI and the integrator);
// an implementer's `npm test` never starts containers (decision 44). When they DO run they run one
// file at a time: see `fileParallelism` below.
// The dashboard's pure helpers (ui/src/lib) are unit-tested from this root config too (plan 07):
// no second vitest install under ui/.
/** Whether this run starts real containers. */
const docker = !!process.env.RUN_DOCKER_TESTS

export default defineConfig({
  test: {
    root: '.', testTimeout: 120_000, hookTimeout: 120_000, pool: 'forks',
    // Restore spies and mock implementations BEFORE each test: vitest applies `restoreMocks` in
    // the runner's `onBeforeTryTask` hook, not after the test that installed them. The outcome
    // is what matters and the mechanism is worth stating correctly, because the two read
    // differently to the next maintainer: nothing cleans up after a test that died, and nothing
    // needs to -- the restore that runs before the NEXT test is what stops a leaked mock
    // reaching it. Three separate review rounds found that leak here: a test installs a gate or
    // a throwing mock, restores it on the line AFTER its assertions, and a timeout -- which is
    // exactly what the concurrency tests exist to detect -- never reaches that line. Measured before
    // enabling: `mockRestore` on a `vi.fn(impl)` restores the implementation passed to `vi.fn`,
    // and every `vi.mock` factory here is that shape, so this returns each file to its intended
    // default rather than blanking it. Nothing in the suite relies on a mock persisting across
    // cases (no module-scope spies, no `beforeAll` mock setup, and the `.int.test.ts` suites use
    // neither `vi.mock` nor `vi.spyOn`).
    restoreMocks: true,
    // ONE Docker suite at a time (CONTRIBUTING, "One Docker suite at a time"). The integration
    // suites share global resources: the single `io-garage` container, dockerd's address pool
    // (stock daemons hand out ~31 user-defined networks), and, for the suites that build their
    // config at module load before the `beforeAll` state-path override, the DEFAULT state file.
    // Vitest runs test FILES in parallel by default, so `RUN_DOCKER_TESTS=1 npm test` started them
    // all at once and they interfered: an eviction case that passes alone failed beside a sibling,
    // and a clone-isolation run died when another suite exhausted the address pool.
    // `fileParallelism: false` serialises the FILES while keeping one process per file, so the
    // state-path isolation the fork pool buys is untouched. Left on for the fake-adapter suites,
    // which share nothing and are the run an implementer waits for.
    fileParallelism: !docker,
    // The default globs also cover templates/scripts/*.test.mjs, which an explicit test-only
    // include would silently drop.
    include: [...configDefaults.include, 'ui/src/lib/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(docker ? [] : ['test/**/*.int.test.ts'])],
  },
})
