// Step 7 of deploy.mjs, driven with a fake fetch and a fake clock so no test waits for real.
import { describe, it, expect } from 'vitest';
import { waitUntilUp } from './health-lib.mjs';

const SVC = 'https://svc.example';

/** Answers each call from script in order (a status or an Error), then repeats the last one. */
function harness(script) {
  const calls = [];
  let t = 0;
  const doFetch = async (url) => {
    const step = script[Math.min(calls.length, script.length - 1)];
    calls.push(url);
    if (step instanceof Error) throw step;
    return { status: step };
  };
  return { calls, opts: { doFetch, sleep: async (ms) => { t += ms; }, now: () => t } };
}

describe('deploy step 7: a service with no health check path', () => {
  it('is up on its first answer whatever the status, bar a proxy 502, 503 or 504', async () => {
    for (const status of [200, 204, 301, 401, 403, 404, 500]) {
      const { calls, opts } = harness([status]);
      expect(await waitUntilUp(SVC, undefined, opts), String(status)).toEqual({ up: true, status });
      expect(calls).toHaveLength(1);
    }
  });

  it('never asks for a particular path', async () => {
    const { calls, opts } = harness([404]);
    await waitUntilUp(SVC, undefined, opts);
    expect(calls).toEqual([SVC]);
  });

  it('keeps polling through 502, 503, 504 and a refused connection until the app answers', async () => {
    const { calls, opts } = harness([new Error('ECONNREFUSED'), 502, 503, 504, 404]);
    expect(await waitUntilUp(SVC, undefined, opts)).toEqual({ up: true, status: 404 });
    expect(calls).toHaveLength(5);
  });

  it('fails once the budget is spent on proxy answers, reporting the last status', async () => {
    const { calls, opts } = harness([503]);
    expect(await waitUntilUp(SVC, undefined, opts)).toEqual({ up: false, status: 503 });
    // The same 180 s budget and 4 s interval a declared path gets.
    expect(calls).toHaveLength(45);
  });

  it('fails with status 0 when nothing ever connects', async () => {
    const { opts } = harness([new Error('ECONNREFUSED')]);
    expect(await waitUntilUp(SVC, undefined, opts)).toEqual({ up: false, status: 0 });
  });
});

describe('deploy step 7: a service that declares a health check path', () => {
  it('is probed on that path, not on /', async () => {
    const { calls, opts } = harness([200]);
    expect(await waitUntilUp(SVC, '/healthz', opts)).toEqual({ up: true, status: 200 });
    expect(calls).toEqual([`${SVC}/healthz`]);
  });

  it('keeps its rule: below 500 is up, so an auth-gated 401 counts', async () => {
    for (const status of [200, 301, 401, 404]) {
      const { opts } = harness([status]);
      expect(await waitUntilUp(SVC, '/healthz', opts), String(status)).toEqual({ up: true, status });
    }
  });

  it('keeps its rule: a 500 or a 5xx from the proxy is not up and is polled past', async () => {
    const { calls, opts } = harness([500, 502, 503, 200]);
    expect(await waitUntilUp(SVC, '/healthz', opts)).toEqual({ up: true, status: 200 });
    expect(calls).toHaveLength(4);
  });

  it('fails once the budget is spent', async () => {
    const { calls, opts } = harness([500]);
    expect(await waitUntilUp(SVC, '/healthz', opts)).toEqual({ up: false, status: 500 });
    expect(calls).toHaveLength(45);
  });
});
