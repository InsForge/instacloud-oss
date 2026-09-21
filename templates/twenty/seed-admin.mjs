// Creates the first workspace and its admin from ADMIN_EMAIL / ADMIN_PASSWORD.
//
// Twenty has no admin-credential environment variable, and its sign-up gate is
//
//   isSignUpEnabled() = IS_MULTIWORKSPACE_ENABLED || workspaceCount === 0
//
// (sign-in-up.service.ts). Single-workspace mode is what this template runs, so the first visitor
// to reach the URL creates the one workspace and every visitor after that is answered
// SIGNUP_DISABLED, "New workspace setup is disabled". A template that ships no credential
// therefore hands the instance to whoever loads the page first, and a deployment somebody else
// verified is one nobody else can ever enter. So the deploy's own credentials take that slot,
// through upstream's own public sign-up mutation rather than by writing rows.
//
// Not fatal: a failure here leaves Twenty exactly as upstream ships it, with sign-up still open,
// which is worth saying out loud in the log rather than taking the service down for.
import { env, exit } from 'node:process';

const email = env.ADMIN_EMAIL ?? '';
const password = env.ADMIN_PASSWORD ?? '';
const base = `http://127.0.0.1:${env.NODE_PORT ?? 3000}`;

// Twenty's own PASSWORD_REGEX (auth.util.ts). Checked here so the reason is one line in the log
// rather than a GraphQL validation error the operator has to decode.
if (!/^.{8,50}$/.test(password)) {
  console.error('seed-admin: ADMIN_PASSWORD must be 8 to 50 characters, which is Twenty\'s own rule');
  exit(1);
}
if (!email.includes('@')) {
  console.error('seed-admin: ADMIN_EMAIL must be an email address; Twenty signs in by email, not by username');
  exit(1);
}

// v2.41.0 serves the core auth resolvers at /metadata and answers /graphql with "Cannot query
// field". That split is upstream's and it has moved before, so both are tried rather than pinned.
const query = `mutation SeedAdmin($email: String!, $password: String!) {
  signUpInWorkspace(email: $email, password: $password) { workspace { id } }
}`;

let lastError = 'no endpoint answered';

for (const path of ['/metadata', '/graphql']) {
  let payload;

  try {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { email, password } }),
      signal: AbortSignal.timeout(60_000),
    });

    payload = await res.json();
  } catch (cause) {
    lastError = `${path}: ${cause.message}`;
    continue;
  }

  const workspaceId = payload?.data?.signUpInWorkspace?.workspace?.id;

  if (workspaceId) {
    console.log(`seed-admin: created the first workspace (${workspaceId}) and its admin account`);
    exit(0);
  }

  const message = payload?.errors?.[0]?.message ?? 'no workspace came back';

  // The schema this build does not serve the mutation on. Anything else is a real refusal and
  // repeating it against the other path would only produce a second confusing error.
  if (/Cannot query field/.test(message)) {
    lastError = `${path}: ${message}`;
    continue;
  }

  // Deliberately the server's message and nothing of the input: these logs are readable to
  // anyone with project access.
  console.error(`seed-admin: twenty refused the sign-up: ${message}`);
  exit(1);
}

console.error(`seed-admin: ${lastError}`);
exit(1);
