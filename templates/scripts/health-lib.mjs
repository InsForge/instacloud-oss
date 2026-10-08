// Step 7 of deploy.mjs: wait until a deployed service answers, injectable so a test can drive it.
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// With a path: below 500 is up. Without one: anything but a proxy's 502, 503 or 504.
function answersAsUp(status, healthcheck) {
  if (!(status > 0)) return false;
  return healthcheck ? status < 500 : ![502, 503, 504].includes(status);
}

/** Polls until the service is up or the budget runs out. Returns { up, status }, 0 if none. */
export async function waitUntilUp(url, healthcheck, { doFetch = fetch, sleep = realSleep, now = Date.now, budgetMs = 180_000, intervalMs = 4000 } = {}) {
  const deadline = now() + budgetMs;
  let status = 0;
  while (now() < deadline) {
    try {
      status = (await doFetch(url + (healthcheck ?? ""), { method: "GET" })).status;
      if (answersAsUp(status, healthcheck)) break;
    } catch { /* cold start */ }
    await sleep(intervalMs);
  }
  return { up: answersAsUp(status, healthcheck), status };
}
