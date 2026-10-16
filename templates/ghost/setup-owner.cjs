// Claims the site, once, through Ghost's own setup endpoint.
//
// POST /ghost/api/admin/authentication/setup is exactly what Ghost's own setup screen calls, and
// it is unauthenticated BY DESIGN: it is the one call that works while no owner exists, and Ghost
// refuses it afterwards (server/services/auth/setup.js asserts the opposite state first). So the
// window this closes is real and it is open from the first second the port answers. The template
// would otherwise publish an HTTPS URL whose first visitor becomes the owner of the site, the
// member list and whatever Stripe account gets connected to it.
//
// Run in the background by ./entrypoint.sh, because there is no CLI equivalent: the server has to
// be listening before this can do anything. Ghost binds the port in step 2 of its boot, with a
// maintenance-mode app that answers 503 until the database is ready (core/boot.js), so the poll
// below is short and it is waiting on real readiness rather than on a fixed sleep.

const PORT = process.env.GHOST_PORT || '2368';
const BASE = `http://127.0.0.1:${PORT}`;
const SETUP = `${BASE}/ghost/api/admin/authentication/setup/`;

// Ghost spends this on migrating an empty schema the first time. Well past the health gate's own
// window on purpose: if the gate has already given up, the container is going away anyway, and a
// slow first migration is not a reason to leave the site unclaimed.
const DEADLINE_MS = 10 * 60 * 1000;
const POLL_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`insta-setup-owner: ${msg}`);

/** Ghost's own "is there an owner yet" check. Reads the users table, so it is also the signal
 *  that the database is up: it 503s behind the maintenance app until then. */
async function status() {
  const res = await fetch(SETUP, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  const body = await res.json();
  return body?.setup?.[0]?.status === true;
}

async function main() {
  const deadline = Date.now() + DEADLINE_MS;
  let done = null;

  for (;;) {
    try {
      done = await status();
    } catch {
      // ECONNREFUSED while the port is still opening. Not worth a line per attempt.
      done = null;
    }
    if (done !== null) break;
    if (Date.now() >= deadline) {
      log(`gave up waiting for ${SETUP} to answer; the setup screen at /ghost is still open`);
      return;
    }
    await sleep(POLL_MS);
  }

  if (done) {
    log('an owner already exists, leaving it alone');
    return;
  }

  const res = await fetch(SETUP, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      setup: [{
        name: process.env.ADMIN_NAME || 'Owner',
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD,
        blogTitle: process.env.SITE_TITLE || 'Ghost',
      }],
    }),
  });

  if (res.status === 201) {
    log(`created the owner ${process.env.ADMIN_EMAIL}; sign in at ${process.env.SITE_URL}/ghost/`);
    return;
  }

  // Not fatal, and deliberately so: Ghost is up and serving, and taking the container down would
  // turn a bad password into a crash loop with the real reason scrolled off the top. The site is
  // reachable, the setup screen is still there, and this line says why it is.
  const detail = await res.text().catch(() => '');
  log(`setup refused with HTTP ${res.status}: ${detail.slice(0, 500)}`);
  log('the setup screen at /ghost is still open, and the first visitor can still claim it');
}

main().catch((err) => log(`failed: ${err && err.message ? err.message : err}`));
