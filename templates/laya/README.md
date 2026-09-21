# Laya

An open-source Jev alternative: a self-hosted typed-decision API over a 421M encoder.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://console.instacloud.com/templates/laya)

## Overview

[Laya](https://github.com/tonychang04/laya-template) is a non-autoregressive decision engine. You
POST it a piece of state (an email, a ticket, a support message) together with typed questions, and
it returns an answer per question in a single forward pass: `choice` picks one of your options,
`score` returns an expected value over an ordered scale, `noul` returns a yes/no probability. There
is no text generation, so there is nothing to parse and no format to repair.

Jev is TypeSafe AI's proprietary decision model; Laya reproduces the same typed-decision
interface with an open Apache-2.0 model and is not affiliated with or endorsed by TypeSafe.

This template is the repository's own `deploy/app.py` behind an HTTPS face, not an API written
here. The `/decide` contract, the question types and the background checkpoint load are all
upstream's, imported unmodified from a pinned commit. What this directory adds is HTTP basic auth,
a route at `/` so the service URL opens the interactive docs instead of a 404, and a build that
bakes the checkpoint into the image.

The checkpoint is `typed-decisions` (ModernBERT-large, 421M, 1024-token context), which is the one
upstream's own deploy directory ships. It runs on CPU. There is no GPU anywhere in this template.

## What you get by hosting it

- A private classification and triage endpoint: your tickets, emails and documents are scored
  inside your own project rather than posted to a model vendor.
- An HTTPS URL with interactive docs at `/docs`, where you can compose a request and send it
  without writing a client.
- A cost profile that is a running container rather than per-token billing, which is the
  difference that matters when the workload is "label every inbound message".
- No cold download. The 842 MB checkpoint is baked into the image and the container never reaches
  the Hugging Face Hub, so what you deploy is exactly what was built and tested.

## What you need before deploying

- A username and a password of your choosing, for the API's basic auth. Nothing else: no API key,
  no model download, no account anywhere.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | Username for HTTP basic auth on every route except `/healthz`. Pick anything without a colon, which basic auth splits on. |
| `ADMIN_PASSWORD` | yes | Password for the same. Neither is generated for you: a generated value would be stored write-only and you could never read it back. |

Set by the template, not by you: `HF_HOME=/opt/hf` (where the build cached the checkpoint),
`HF_HUB_OFFLINE=1` (a cache miss becomes a loud failure rather than a silent 842 MB download),
`PORT=8080`, and `USE_TF=0` / `USE_TORCH=1` / `TOKENIZERS_PARALLELISM=false`, the three upstream
sets in its own CI because transformers probes for TensorFlow at import and can deadlock model
construction when it finds one.

The service declares no volume. It holds no state: a request carries the state it asks about, and
nothing is written between requests.

## After deploy

1. Open `https://<your-service-url>/`. It redirects to `/docs` and the browser asks for the
   credentials you set.
2. Expand `POST /decide`, choose **Try it out**, and send something like:

   ```json
   {
     "state": "Hi, we were billed twice for March. Please refund the duplicate today or we will cancel our plan.",
     "questions": [
       {"type": "choice", "instructions": "Which department should handle this?",
        "options": ["billing", "technical", "sales"]},
       {"type": "score", "instructions": "How urgent is this?",
        "options": ["not urgent", "soon", "blocking"]},
       {"type": "noul", "instructions": "Does the user threaten to cancel?"}
     ]
   }
   ```

   The response carries one entry per question, in order, each with its probabilities and a
   `confidence`, plus the server-side `latency_ms`.

3. `GET /healthz` is open (no credential) and reports `model_loaded` and `load_seconds`. **After a
   cold start the checkpoint loads in a background thread and `/decide` answers 503 with
   `model still loading` until it finishes.** Measured on this platform: 22.8 s on a first boot and
   43.2 s after a restart, when the page cache is cold. The service is not always-on, so an idle
   machine stops and the next request pays that wait again. Poll `/healthz` if you are scripting
   against it.

   Once warm, and on a state of roughly 125 tokens: 71.5 ms for one question and about 320 ms for
   three. The first request after a restart cost 1030.7 ms. Latency grows with the length of the
   state, at roughly 1.1 ms per input token per upstream's own measurements.

Two properties worth knowing before you build on the answers, both of them upstream's own findings
recorded in `deploy/DEPLOY-CLOUD.md` and `BENCHMARKS.md`: input past roughly 1K tokens is silently
truncated, so keep states short; and the `confidence` values are miscalibrated per upstream's own
ECE numbers, so rank by them rather than reading them as probabilities of being right.

## Links

- Architectures: `linux/amd64` only. The image installs CPU torch and runs a real prediction at
  build time to bake the checkpoint, and nothing has yet proved that sequence under QEMU for
  arm64. The manifest says so, so the platform refuses an arm64 box before creating anything.
- Upstream: <https://github.com/tonychang04/laya-template>, pinned to commit `c9dcaab`
- Model: <https://huggingface.co/convaiinnovations/laya>, `typed-decisions` subfolder
- License: Apache-2.0 (upstream `tonychang04/laya-template`, and the model weights).
