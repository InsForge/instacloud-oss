# LobeHub

Self-hosted chat workspace for agents across many model vendors.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/lobehub)

## Overview

[LobeHub](https://github.com/lobehub/lobehub), formerly LobeChat, is a chat interface for large
language models that you host yourself. You sign in, pick a provider, and talk to it. Around that
sit agents you configure and reuse, agent groups that work on something together, a knowledge base
you upload files into, image generation, and a plugin system that speaks MCP. It talks to roughly
fifty model vendors, so one deployment is a single front end for OpenAI, Anthropic, Google,
OpenRouter, Ollama and the rest.

This template runs the official `lobehub/lobehub` image. The overlay image it builds adds two
files and rebuilds nothing: upstream's Next.js build, its Drizzle migrations and its launcher are
all untouched, and upstream's own `startServer.js` runs as the last line of the entrypoint. The
three steps in front of it are:

- **It skips the two migrations that need ParadeDB.** Upstream's self-host stack runs
  `paradedb/paradedb`, and two migrations depend on it: one creates the `pg_search` extension, the
  next builds fourteen BM25 indexes with it. The managed Postgres has pgvector but not pg_search,
  so `CREATE EXTENSION pg_search` ends the migration run and the server never starts. The
  entrypoint rewrites those files as no-ops inside the running container, and the manifest sets
  `FTS_SEARCH_PROVIDER=pg_like`, which is upstream's own extension-free search provider. What this
  costs is under [Full-text search](#full-text-search) below.
- **It derives `KEY_VAULTS_SECRET`.** LobeHub encrypts the provider API keys users paste into its
  settings with AES, and wants a value that base64-decodes to exactly 16, 24 or 32 bytes. The
  entrypoint hashes the generated seed into 32 bytes, so the length is right whatever the generator
  mints.
- **It mints the RS256 key set** that signs LobeHub's internal JWTs, on first boot, and keeps it on
  the volume. Upstream's `setup.sh` generates one per deployment; a manifest generator mints random
  characters, not a key pair.

Accounts, conversations, agents and memories are rows in the managed Postgres the template
provisions. Uploads and generated images are meant for the managed bucket beside it, but
**uploading from the browser does not work yet**: see [File uploads](#file-uploads). The volume
holds only the key set.

## What you get by hosting it

- An HTTPS URL for the whole of LobeHub: the chat workspace, the agent builder, the settings pages
  and the API routes under `/api` and `/webapi`.
- A managed Postgres database, provisioned and wired in by the template. The migrations run on
  every boot, so updating this template migrates the schema on the way up.
- Conversations and the API keys behind them on infrastructure you control, which is the usual
  reason to run this rather than use someone's hosted chat.
- Sign-up closed to a single address from the first boot, because `AUTH_ALLOWED_EMAILS` is a
  required variable rather than an afterthought.
- The machine idle-stops and wakes on the next request.

## What you need before deploying

- **An email address to sign up with.** It goes in `AUTH_ALLOWED_EMAILS` at the deploy prompt, and
  it is the only address that can create an account. LobeHub has no admin account and sends no
  invitation, so an address you cannot receive at leaves you locked out.
- **An API key for at least one model vendor**, eventually. Nothing here needs one to boot, and
  each user can paste their own into LobeHub's settings after signing in, where it is stored
  encrypted. The optional variables below are the alternative: a key set once, for everyone on the
  deployment.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `AUTH_ALLOWED_EMAILS` | yes | The address allowed to register, e.g. `you@example.com`. A bare domain lets anyone at that domain in; a comma-separated list lets several addresses in. Everyone else is refused at sign-up. |
| `OPENAI_API_KEY` | no | OpenAI key, from platform.openai.com. Gives every account here a working OpenAI provider. |
| `OPENAI_PROXY_URL` | no | Base URL for OpenAI-compatible requests. Defaults to `https://api.openai.com/v1`. |
| `ANTHROPIC_API_KEY` | no | Anthropic key, from console.anthropic.com. |
| `GOOGLE_API_KEY` | no | Google Gemini key, from aistudio.google.com. |
| `OPENROUTER_API_KEY` | no | OpenRouter key, from openrouter.ai. One key for many vendors, and the shortest route to a working deployment. |
| `AUTH_DISABLE_EMAIL_PASSWORD` | no | Set to `1` once your account exists to close the sign-up form outright. |

Set by the template, not by you: `DATABASE_URL` points at the managed Postgres service and the
five `S3_*` variables at the managed bucket; `AUTH_SECRET` is a generated 64-character secret that
signs sessions; `LOBE_KEY_VAULTS_SEED` is the generated seed the entrypoint turns into
`KEY_VAULTS_SECRET`; `APP_URL` is this service's own URL, which is what better-auth checks every
sign-in request's origin against.

## After deploy

1. Open the service URL. You land on LobeHub's sign-in page.
2. Click through to **Sign up** and register with the address you put in `AUTH_ALLOWED_EMAILS`.
   The password has to be at least 8 characters and carry both letters and digits. Signing up
   signs you straight in; there is no confirmation email, and no SMTP server is configured.
3. Walk through onboarding: telemetry, response language, your name, your interests. The last
   step offers a starter set of agents and says *Failed to load templates*, because that picker
   is served by LobeHub's hosted marketplace and a self-hosted deployment has no credentials for
   it. Click **Skip for now**; nothing else in the product depends on it.
4. You land in the workspace. Open **Settings → AI Service Provider**, pick a provider, and paste
   an API key, unless you set one of the key variables at deploy.
5. Start a chat and send a message. The reply streams back from whichever provider you configured.
6. Close the door behind you, optionally: set `AUTH_DISABLE_EMAIL_PASSWORD` to `1` so the sign-up
   form stops accepting anything at all.

`/api/version` answers `{"version":"..."}` without a session and is what the health gate reads.

## File uploads

They do not work yet, and nothing in this template can fix it. LobeHub asks its server for a
presigned S3 URL and then PUTs the file to it **from the browser**. The managed bucket answers the
preflight with 200 and no `Access-Control-Allow-Origin`, so the browser refuses to send the PUT and
LobeHub calls its own abort route. The same presigned URL, replayed with `curl`, returns 200: the
credentials, the signature and the virtual-host addressing are all correct, and what is missing is
a CORS rule on the bucket, which is neither a manifest field nor an `insta storage` command today.

Everything that does not touch a file works: chat, agents, agent groups, memory and settings.
Attachments, image generation and the knowledge base need the upload leg.

## Full-text search

LobeHub ships three search providers and this deployment runs the third. `pg_search` is ParadeDB
BM25 and is upstream's self-host default; `elasticsearch` wants a cluster; `pg_like` is, in
upstream's words, "extension-free PostgreSQL `ILIKE` matching for lightweight deployments". The
managed Postgres cannot offer the first and the template does not run the second, so searching
your conversations, agents and files matches substrings rather than ranking by relevance.

One place does not read that setting: searching **memories** by text builds a `paradedb.match`
query whenever the driver is real Postgres rather than the in-process test database
(`packages/database/src/models/userMemory/model.ts`), so a text search over memories errors here
rather than falling back. Everything else about memories works. Run upstream's own compose stack
with ParadeDB if full-text search over your whole workspace is the reason you are deploying this.

## Links

- Upstream: <https://github.com/lobehub/lobehub>, pinned at `2.2.19`
- Image: `docker.io/lobehub/lobehub:2.2.19`, with this directory's `Dockerfile` on top
- Documentation: <https://lobehub.com/docs/self-hosting>
- License: LobeHub Community License, which is Apache-2.0 plus two conditions. One allows
  commercial use "as a frontend and backend service without modifying the source code"; the other
  reserves derivative works to a commercial license. The overlay adds a launcher and edits nothing
  upstream ships, which is why the migration rewrite happens in the running container.
