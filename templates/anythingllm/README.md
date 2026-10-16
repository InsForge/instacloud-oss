# AnythingLLM

Private ChatGPT over your own documents.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/anythingllm)

## Overview

[AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) is a full-stack chat application that
puts a ChatGPT-style interface in front of whatever LLM you point it at, and lets you drop
documents into a workspace so the model answers from them. Upstream describes it as an all-in-one
AI app with built-in RAG, AI agents, and a no-code agent builder.

This template runs upstream's official image with a thin overlay that redirects two state paths
onto the persistent volume. It is the upstream application, not an API written here: everything you
see after deploy is AnythingLLM's own UI, and the overlay adds no features.

**It brings no model with it.** AnythingLLM is a client: you connect it to OpenAI, Anthropic,
Ollama, a local LM Studio, or any of the other providers on its settings page, and that provider
does the inference and bills you for it. The only thing that runs on this machine by default is the
embedding model, which AnythingLLM downloads on first use.

## What you get by hosting it

- An HTTPS URL for the AnythingLLM UI, behind a password you set at deploy time.
- A persistent volume at `/data` holding the whole install: the SQLite database with your
  workspaces, chats and users, the documents you upload, the LanceDB vector index, the embedding
  model once it downloads, and the settings file. Upstream splits those across two directories that
  no environment variable can move together, which is the one thing this template's overlay exists
  to fix.
- The JWT secret and the data-encryption key and salt generated for you and held as managed
  secrets, so sessions and encrypted rows survive a restart.
- Your documents on infrastructure you control, rather than uploaded to a hosted tier.

## What you need before deploying

- A password for the sign-in screen. There is no username.
- An API key for whichever LLM provider you want to chat with, unless you are pointing
  AnythingLLM at a model you host elsewhere. You can add it on the deploy form or on the
  settings page afterwards; neither is required to get the instance up.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_PASSWORD` | yes | The password for the sign-in screen, and the whole credential: AnythingLLM's single-user mode has no username field. It also guards the settings pages where your provider API keys are stored. |
| `LLM_PROVIDER` | optional | Which LLM to chat with, as AnythingLLM's own provider id (`openai`, `anthropic`, `gemini`, `ollama`, and so on). Blank means the onboarding screen asks you after deploy. |
| `OPEN_AI_KEY` | optional | OpenAI API key, from <https://platform.openai.com/api-keys>, used when `LLM_PROVIDER` is `openai`. Blank means you add a key for whichever provider you pick, later, under Settings. |
| `JWT_SECRET` | generated | Signs the session token. You do not set it. Single-user password mode checks for both this and the password and lets every request through if either is missing, so the template always supplies it. |
| `SIG_KEY` / `SIG_SALT` | generated | Passphrase and salt for the key AnythingLLM encrypts stored data with. They must stay stable across restarts, or previously encrypted rows stop decrypting. |

Set by the template, not by you: `STORAGE_DIR=/app/server/storage` and `SERVER_PORT=3001`.

Every other setting, and there are a lot of them, lives in the app's own UI under **Settings**:
the provider and model, the embedder, the vector database, chat defaults, agent skills and users.

## After deploy

1. Open the service URL. You get a password prompt; the password is the one you typed on the
   deploy form. There is no onboarding wizard: AnythingLLM treats an instance that already has a
   password and a JWT secret as onboarded, so you land straight in the app.
2. Go to **Settings > AI Providers > LLM**, pick a provider and paste its API key. Until you do,
   sending a chat answers `Unknown provider: undefined`. The embedder and vector database below it
   default to **AnythingLLM Embedder** and **LanceDB**, both of which run on this machine and need
   no key.
3. Create a workspace, then open its document manager, upload a file, select it and click
   **Move to Workspace**, then **Save and Embed**. The first embed downloads the embedding model
   (roughly 50 MB) onto the volume and is slower than the ones after it.
4. Ask a question about the document. The answer carries citations back to the chunks it used.
5. Optionally switch the instance to multi-user mode under **Settings > Security**, which replaces
   the single password with real accounts. From that point AnythingLLM ignores `ADMIN_PASSWORD`.

## Scope

**The volume is the only copy.** Workspaces, chats, uploaded documents and the vector index all sit
on one volume, and nothing here snapshots or replicates it.

**The service is not always-on.** Chats, uploads and embedding are all driven by an inbound
request, and that request is what wakes the machine, so idle-stopping costs nothing but the first
request's cold start. AnythingLLM's **scheduled agent jobs** are the exception: they fire from
inside the process, and a stopped machine runs none of them. Set `alwaysOn: true` on the service if
you create any.

**Single instance, SQLite.** This is upstream's default configuration. Upstream also publishes a
`pg-*` image variant that reads a PostgreSQL connection string, which this template does not use.

## Links

- Architectures: `linux/amd64` and `linux/arm64`.
- Documentation: <https://docs.anythingllm.com>
- Upstream: <https://github.com/Mintplex-Labs/anything-llm>
- Upstream image: `docker.io/mintplexlabs/anythingllm`; this template deploys
  `ghcr.io/insforge/insta-oss/templates/anythingllm`, built from the `Dockerfile` here.
- License: MIT (see <https://github.com/Mintplex-Labs/anything-llm/blob/master/LICENSE>).
