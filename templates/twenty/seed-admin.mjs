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
// through the same two mutations the welcome page calls rather than by writing rows.
//
// Not fatal: a failure here leaves Twenty exactly as upstream ships it, with sign-up still open,
// which is worth saying out loud in the log rather than taking the service down for.
import { env, exit } from 'node:process';

const email = env.ADMIN_EMAIL ?? '';
const password = env.ADMIN_PASSWORD ?? '';
const displayName = (env.WORKSPACE_NAME ?? '').trim() || 'Twenty';
const base = `http://127.0.0.1:${env.NODE_PORT ?? 3000}`;
// The address a browser would come in on, which is what Twenty issues a workspace token against.
const origin = env.SERVER_URL ?? base;

// Twenty's own PASSWORD_REGEX (auth.util.ts). Checked here so the reason is one line in the log
// rather than a GraphQL validation error the operator has to decode.
if (!/^.{8,50}$/.test(password)) {
  console.error("seed-admin: ADMIN_PASSWORD must be 8 to 50 characters, which is Twenty's own rule");
  exit(1);
}
if (!email.includes('@')) {
  console.error('seed-admin: ADMIN_EMAIL must be an email address; Twenty signs in by email, not by username');
  exit(1);
}

// v2.41.0 serves the core auth resolvers at /metadata and answers /graphql with "Cannot query
// field". That split is upstream's and it has moved before, so the first path that recognises the
// schema wins instead of one being pinned.
let endpoint = null;

async function call(query, variables, token) {
  const headers = { 'content-type': 'application/json' };

  if (token) headers.authorization = `Bearer ${token}`;

  for (const path of endpoint ? [endpoint] : ['/metadata', '/graphql']) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(60_000),
    });
    const payload = await res.json();
    const message = payload?.errors?.[0]?.message;

    if (message && /Cannot query field/.test(message)) continue;

    endpoint = path;

    return { data: payload?.data, error: message };
  }

  return { error: 'no endpoint served the auth schema' };
}

// Step one, the welcome page's own first call: a user with no workspace yet, and a
// workspace-agnostic token to create one with. A user row surviving a half-finished earlier
// attempt is not a failure, so the sign-in path covers that rather than leaving the instance
// wedged with an account and no workspace.
const TOKEN = 'tokens { accessOrWorkspaceAgnosticToken { token } }';
const MINE = 'availableWorkspaces { availableWorkspacesForSignIn { id loginToken } }';
let step = await call(`mutation Up($email: String!, $password: String!) { signUp(email: $email, password: $password) { ${TOKEN} } }`, { email, password });
let tokens = step.data?.signUp?.tokens;
// A workspace this account already has. Empty on the deploy this script exists for, and the
// resume path when a boot got the account made and then died before the workspace was usable.
let existing = null;

if (!tokens) {
  const retry = await call(`mutation In($email: String!, $password: String!) { signIn(email: $email, password: $password) { ${TOKEN} ${MINE} } }`, { email, password });

  tokens = retry.data?.signIn?.tokens;
  if (!tokens) {
    // The sign-up error, not the sign-in one: sign-in is the fallback and its "user not found"
    // would only hide why the sign-up itself was refused.
    console.error(`seed-admin: twenty refused the sign-up: ${step.error ?? 'no tokens came back'}`);
    exit(1);
  }
  existing = retry.data?.signIn?.availableWorkspaces?.availableWorkspacesForSignIn?.[0] ?? null;
  console.log(
    existing
      ? 'seed-admin: the admin account and its workspace already exist, picking up where the last boot stopped'
      : 'seed-admin: the admin account already existed, giving it the workspace it was missing',
  );
}

// Step two. `signUpOnNewWorkspace` throws "Workspace name is required" without a displayName,
// which is why this is a separate call and not a single signUpInWorkspace.
let workspaceId = existing?.id;

if (!workspaceId) {
  step = await call(
    'mutation New($displayName: String!) { signUpInNewWorkspace(input: { displayName: $displayName }) { workspace { id } } }',
    { displayName },
    tokens.accessOrWorkspaceAgnosticToken?.token,
  );

  workspaceId = step.data?.signUpInNewWorkspace?.workspace?.id;

  if (!workspaceId) {
    // Deliberately the server's message and nothing of the input: these logs are readable to
    // anyone with project access.
    console.error(`seed-admin: twenty refused to create the workspace: ${step.error ?? 'no workspace came back'}`);
    exit(1);
  }

  console.log(`seed-admin: created the workspace ${displayName} (${workspaceId}) and its admin account`);
}

// Step three, and the one a deploy cannot leave out. `signUpInNewWorkspace` only writes the
// workspace row, as PENDING_CREATION: its schema, its standard objects, its views and Twenty's
// example records are all built by `activateWorkspace`, which upstream's welcome page calls from
// the browser on the screen after the workspace name. Skip it and the deploy hands over a
// half-made instance that finishes building itself whenever somebody first opens the URL — and
// since that is also when the example records appear, they arrive looking like data the operator
// has somehow already got.
//
// It needs a workspace-scoped token, which is a second sign-in: the agnostic token above belongs
// to a user who had no workspace when it was minted.
step = await call(
  `mutation In($email: String!, $password: String!) { signIn(email: $email, password: $password) { availableWorkspaces { availableWorkspacesForSignIn { id loginToken } } } }`,
  { email, password },
);
const available = step.data?.signIn?.availableWorkspaces?.availableWorkspacesForSignIn ?? [];
const loginToken = available.find((w) => w.id === workspaceId)?.loginToken;

// Non-fatal from here down: the account exists and works, and Twenty will activate the workspace
// itself the first time somebody signs in. Saying so is what stops that from looking like a bug
// in the app later.
const unfinished = 'seed-admin: the workspace is created but not activated; twenty will finish it on the first sign-in';

if (!loginToken) {
  console.error(`${unfinished} (no login token: ${step.error ?? 'none came back'})`);
  exit(0);
}

// The origin the browser would have used. Loopback is not it, and the token is issued against the
// workspace this address resolves to.
step = await call(
  `mutation Auth($loginToken: String!, $origin: String!) { getAuthTokensFromLoginToken(loginToken: $loginToken, origin: $origin) { ${TOKEN} } }`,
  { loginToken, origin },
);
const workspaceToken = step.data?.getAuthTokensFromLoginToken?.tokens?.accessOrWorkspaceAgnosticToken?.token;

if (!workspaceToken) {
  console.error(`${unfinished} (no workspace token: ${step.error ?? 'none came back'})`);
  exit(0);
}

// Idempotent on the server's side: activateWorkspace takes an activation lock and returns the
// workspace untouched when it is already ACTIVE, so a boot that retries this cannot rebuild a
// workspace somebody is using.
step = await call(
  'mutation Act($displayName: String!) { activateWorkspace(data: { displayName: $displayName }) { id activationStatus } }',
  { displayName },
  workspaceToken,
);
const activationStatus = step.data?.activateWorkspace?.activationStatus;

if (activationStatus !== 'ACTIVE') {
  console.error(`${unfinished} (${step.error ?? activationStatus ?? 'no status came back'})`);
  exit(0);
}

console.log(`seed-admin: activated the workspace, so the CRM is ready before anyone opens it`);
