# lev

Typed, calibrated decisions from one forward pass and zero output tokens.

> **Draft.** The template deploys and answers: a typed decision comes back in 4 to 6 seconds once
> the machine is warm. It does that with 9.3 GB of bf16 weights memory-mapped off the volume on a
> machine whose memory ceiling is 8 GB, which works but means the service has to be always-on and
> so bills around the clock for a CPU decision. Whether that belongs in the catalog is the call
> this stays draft for; the measurements are on the pull request that added this directory.

## Overview

[lev](https://github.com/Abhinavexists/lev) is an open System One decision model. You send it a
**state** (text, a ticket, an email, a blob of JSON) together with a set of typed questions
(yes/no, a choice between options, a score), and it answers all of them in one forward pass by
reading each answer off logits it has already computed. It returns a calibrated probability
distribution over exactly the options you supplied and generates no tokens, so there is no JSON to
parse and no retry loop: the model cannot return a label outside your option set, because the
answer space *is* your option set. It can still pick the wrong option; the guarantee is structural,
not a guarantee of correctness.

The model is a LoRA adapter published as
[`interfaze-ai/lev`](https://huggingface.co/interfaze-ai/lev) along with a Mode B head and a
calibration profile. Its release manifest names `Qwen/Qwen3.5-4B` as the backbone and that
overrides `lev serve`'s own `Qwen/Qwen3.5-4B-Base` default, so `Qwen/Qwen3.5-4B` is what `/health`
reports and what gets loaded. Upstream reports 68.9% macro accuracy across all 13 S1Bench subsets.

The wire protocol is TypeSafe's `/v1/systemone`, so any TypeSafe client works against it by
changing the base URL.

This template is the upstream package served over HTTPS, not an API written here. `lev.server`'s
own app, request models and routes are imported unmodified from the pinned commit; `./serve.py`
adds only the three things a library has no reason to carry and a public service does: it moves
the backbone load into a background thread so the health gate is not waiting on a 9.3 GB download,
it turns `/health` into a 503 if that load fails so a broken service cannot pass the gate, and it
puts an API key in front of everything except `/health`.

## What you get by hosting it

- A `/v1/systemone` endpoint on an HTTPS URL, behind an API key of your choosing.
- The interactive OpenAPI docs at `/docs`, which are the only UI this API has. `/` redirects there.
- The released adapter, head and calibration profile fetched at first boot and kept on the volume,
  so a restart re-maps them from disk instead of re-downloading 9.5 GB.
- An endpoint any TypeSafe client can use unchanged by pointing its base URL here.

## What you need before deploying

- An API key of your own choosing. Nothing generates one for you, and it cannot be read back after
  deploy, so decide it and keep a copy.
- Nothing else. The backbone and the adapter are both public on the Hugging Face Hub and are
  fetched without credentials.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `API_KEY` | yes | Guards every route except `/health`. Send it as `Authorization: Bearer <key>`, or as HTTP basic auth with the username `api` and the key as the password. A TypeSafe SDK client points its `api_key` at this value. No default and no generator: you pick it, and it cannot be read back afterwards. |
| `HF_TOKEN` | no | Only needed if you repoint `LEV_CHECKPOINT` at a private repository of your own. Leave blank for the released public adapter. |
| `LEV_CHECKPOINT` | preset | `interfaze-ai/lev`, the released adapter. Change it from the console to serve your own release directory or Hub id, or clear it to serve the untrained backbone. |

Set by the template, not by you: `HF_HOME=/data/hf` (the Hub cache on the volume, which is what
makes a restart cheap), `OMP_NUM_THREADS=8` (the platform's compute ceiling is 8 shared vCPUs and a
forward pass here is CPU-bound across all of them), `PORT=8080`, and `USE_TF=0` / `USE_TORCH=1` /
`TOKENIZERS_PARALLELISM=false`, which keep transformers from probing for TensorFlow at import.

The service is **always-on**. An idle volume-bearing compute service is stopped, so the next
request would pay a cold start plus a fresh map of the backbone, and the edge in front of the
service cuts a connection at 60 seconds: the measured 69 seconds to a loaded engine plus 36
seconds for the first decision do not fit inside that. Always-on bills continuously.

## After deploy

The first boot fetches about 9.5 GB from the Hugging Face Hub before it can answer anything. The
deploy goes green well before that finishes, which is deliberate: `/health` answers 200 with
`{"status": "loading"}` from the moment the socket binds, and `/v1/systemone` answers **529** until
the weights are mapped. Watch the progress at `/status`, which reports `loading`, `ready` or
`failed` and how long the load took.

What that looked like on one deployment, so you know roughly what to expect: 25 seconds from boot
to `ready` on the first start, 69 seconds after a restart (no download either time after the
first, since the cache is on the volume). The first decision after a restart took 36 seconds
because the forward pass has to fault the weights in off the disk; every one after that took 4 to
6 seconds. The edge in front of the service cuts a connection at 60 seconds, so give a restarted
service its first request before you point real traffic at it.

Once `/health` reports `"status": "ok"`, ask it something:

```bash
curl -sS -u api:<your-key> https://<your-service-url>/v1/systemone \
  -H 'content-type: application/json' \
  -d '{
    "state": "Hi, I was charged twice for order #4471 and I want a refund.",
    "questions": {
      "intent": {
        "type": "choice",
        "instructions": "What does the customer want?",
        "criteria": {"refund": "wants money back", "cancel": null, "track": null, "other": null}
      },
      "urgent": {"type": "noul", "instructions": "Does this need a human within the hour?"}
    }
  }'
```

The answer carries `answers.intent.choice`, a probability per option, `answers.urgent.noul` as the
probability the answer is yes, and `usage.output_tokens`, which is `0`.

Or open `/docs` in a browser. It will prompt for credentials: the username is `api` and the
password is your `API_KEY`.

## Links

- Upstream: <https://github.com/Abhinavexists/lev>, pinned at commit
  `cf104b69329302e4eac674a730c71f3511047db8` (the repository publishes no releases and no tags, so
  the commit is the pin). The PyPI name `lev` is an unrelated placeholder package and is not used.
- Weights: <https://huggingface.co/interfaze-ai/lev>, on `Qwen/Qwen3.5-4B`
- Benchmarks: <https://github.com/Abhinavexists/lev/blob/main/docs/FINDINGS.md>
- Image: `ghcr.io/insforge/insta-oss/templates/lev`, built from `./Dockerfile`
- License: Apache-2.0 (upstream `Abhinavexists/lev`, and the adapter weights). The backbone is
  Qwen's, under its own licence.
