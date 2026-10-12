# Hindsight

Agent memory server with retain, recall and reflect.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/hindsight)

## Overview

[Hindsight](https://github.com/vectorize-io/hindsight) is a long-term memory service for AI agents.
An agent pushes what it learns in with `retain`, asks for it back with `recall`, and asks the server
to reason over it with `reflect`. Behind those three calls the server extracts facts, entities,
relationships and timestamps with an LLM, stores them as vectors and a graph, and retrieves them
with four strategies at once (semantic, BM25, graph expansion and temporal) before reranking the
result. Memories live in isolated **banks**, one per user or per agent.

It speaks three ways: a REST API, SDKs for Python, TypeScript, Go and Rust, and a built-in MCP
endpoint at `/mcp/{bank_id}/` that any MCP client can point at.

This template deploys two of upstream's own published images, unmodified and pinned:

| Service | Image | What it is |
| --- | --- | --- |
| `api` | `ghcr.io/vectorize-io/hindsight-api` | The memory server, its embedded PostgreSQL, and the MCP endpoint |
| `console` | `ghcr.io/vectorize-io/hindsight-control-plane` | Upstream's Control Plane dashboard, which reads the API |

There is no overlay Dockerfile here and no code in this repository between you and the app. The
dashboard is upstream's, not one written here.

## What you get by hosting it

- Your agents' memory on a volume you own. The database is the embedded PostgreSQL the server
  starts for itself, so there is no second datastore to provision and nothing leaves the project.
- Embeddings and reranking that run in the container. `BAAI/bge-small-en-v1.5` and
  `cross-encoder/ms-marco-MiniLM-L-6-v2` are baked into the image, so the only model credential the
  deployment needs is the one for the LLM that extracts facts.
- A free choice of LLM provider. Because nothing but fact extraction and reflect calls out, any of
  upstream's providers works: OpenAI, Anthropic, Gemini, Groq, Bedrock, Vertex AI, DeepSeek, a
  LiteLLM gateway, or a local Ollama or LM Studio endpoint.
- A bearer token in front of the API. The built-in API-key tenant extension is switched on by this
  template, so every `/v1` and `/mcp` route answers 401 without the key rather than handing out the
  memories and the LLM spend. The four routes that carry no memories stay open as upstream ships
  them: `/health`, which is what the platform's deploy gate probes, plus `/version`, `/metrics` and
  the `/docs` API reference.
- The dashboard behind its own password, on its own URL, scaling to zero when nobody is looking at
  it.
- An MCP endpoint per bank, so a coding agent or a chat client can read and write memory with no
  SDK at all.

## What you need before deploying

- An API key for the LLM provider that will do the fact extraction. An OpenAI key works with the
  defaults; any other provider needs its own key plus `HINDSIGHT_API_LLM_PROVIDER`. The field is
  required whichever provider you pick, because the common ones all need it and an instance that
  cannot extract a fact looks healthy until the first retain. For a provider that authenticates some
  other way (`ollama`, `lmstudio`, `llamacpp`, or a subscription provider such as `claude-code`),
  put a placeholder in it.
- A token of your own choosing for the API, and a password of your own choosing for the dashboard.
  Neither has a default and neither is generated for you, so keep a copy of both: variable values
  cannot be read back after deploy.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `HINDSIGHT_API_TENANT_API_KEY` | yes | Bearer token every client sends as `Authorization: Bearer <key>` to the API, including the SDKs and MCP clients. Pick your own strong random string. |
| `HINDSIGHT_API_LLM_API_KEY` | yes | Key for the LLM provider that extracts facts on retain and answers reflect. An OpenAI key with the defaults. Required for every provider, so a provider that authenticates some other way takes a placeholder here. |
| `HINDSIGHT_CP_ACCESS_KEY` | yes | Password for the dashboard's login page. Independent of the API token, because one is typed by a person and the other is pasted into agent config. |
| `HINDSIGHT_CP_DATAPLANE_API_KEY` | yes | The same value as `HINDSIGHT_API_TENANT_API_KEY`. The dashboard sends it to the API as its bearer token; asked for separately because a template variable is its environment variable name, and the two services spell the same secret differently. |
| `HINDSIGHT_API_LLM_PROVIDER` | no | `openai` (the default), `anthropic`, `gemini`, `groq`, `deepseek`, `bedrock`, `vertexai`, `ollama`, `litellm` and about twenty more. |
| `HINDSIGHT_API_LLM_MODEL` | no | Model id for that provider. Blank uses the provider's own default. |
| `HINDSIGHT_API_LLM_BASE_URL` | no | Base URL of an OpenAI-compatible endpoint, for a gateway or a self-hosted model. |

Set by the template, not by you: `HOME` points at `/data` so the embedded PostgreSQL cluster lands
on the volume, `HF_HOME` stays at the path the image cached its two models under so they are not
re-downloaded on a fresh machine, the API-key tenant extension is enabled, and the dashboard is
given the API's URL. Every other setting in upstream's long
[configuration reference](https://hindsight.vectorize.io/developer/configuration) can be added as a
service variable afterwards.

## After deploy

1. Open the `console` service's URL. The login page asks for the `HINDSIGHT_CP_ACCESS_KEY` you
   chose, and nothing else.
2. Point a client at the `api` service's URL with your token:

   ```python
   from hindsight_client import Hindsight

   client = Hindsight(base_url="https://<your-api-url>", api_key="<HINDSIGHT_API_TENANT_API_KEY>")
   client.retain(bank_id="my-bank", content="Alice works at Google as a software engineer")
   client.recall(bank_id="my-bank", query="What does Alice do?")
   ```

   The first `retain` creates the bank; there is no separate create step.
3. Watch it land in the dashboard. Banks > `my-bank` > Documents lists what you retained with the
   count of memory units the server made from it, and Memories and Entities show those units and
   the entities they resolved to. Same data, read back through a different route.
4. For an MCP client, use `https://<your-api-url>/mcp/<bank-id>/` with the same bearer token.
   `retain`, `recall` and `reflect` arrive as tools.

Retain is asynchronous: the call returns an operation id and the extraction, consolidation and
embedding happen on the server afterwards. That is why the `api` service is always-on, and why a
memory can take a few seconds to become recallable.

## Links

- Upstream: <https://github.com/vectorize-io/hindsight>
- Documentation: <https://hindsight.vectorize.io>
- Images: `ghcr.io/vectorize-io/hindsight-api` and `ghcr.io/vectorize-io/hindsight-control-plane`
- License: MIT
