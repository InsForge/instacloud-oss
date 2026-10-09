# lev

An open System One decision model behind a Jev-compatible API: typed yes/no, choice and score
answers with calibrated probabilities, on CPU, in your own project.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/lev)

**This service is always-on and billed the whole time it exists.** It cannot scale to zero, for
the reason in the [FAQ](#faq), so a deployment you are done with is a deployment to delete. The
warm decision it buys you is 4 to 6 seconds of CPU.

## Overview

[lev](https://github.com/Abhinavexists/lev) is an open System One decision model. You send it a
**state** (text, a ticket, an email, a blob of JSON) together with a set of typed questions
(yes/no, a choice between options, a score), and it answers all of them in one forward pass by
reading each answer off logits it has already computed. It returns a calibrated probability
distribution over exactly the options you supplied and generates no tokens, so there is no JSON to
parse and no retry loop: the model cannot return a label outside your option set, because the
answer space *is* your option set. It can still pick the wrong option. The guarantee is
structural, not a guarantee of correctness.

- `choice` picks one of your options, with a probability for each
- `score` is an expected value over an ordered scale
- `noul` is the probability that something is true

Typical uses: routing tickets, classifying email, scoring urgency, gating a more expensive LLM call.

The model is a LoRA adapter published as
[`interfaze-ai/lev`](https://huggingface.co/interfaze-ai/lev) along with a Mode B head and a
calibration profile. Its release manifest names `Qwen/Qwen3.5-4B` as the backbone and that
overrides `lev serve`'s own `Qwen/Qwen3.5-4B-Base` default, so `Qwen/Qwen3.5-4B` is what `/health`
reports and what gets loaded. Upstream reports 68.9% macro accuracy across all 13 S1Bench subsets,
with the caveats under [Limits](#limits).

Jev is TypeSafe AI's proprietary decision model. The wire protocol here is TypeSafe's
`/v1/systemone`, so a TypeSafe client works against this service by changing its base URL. Not
affiliated with or endorsed by TypeSafe.

This template is the upstream package served over HTTPS, not an API written here. `lev.server`'s
own app, request models and routes are imported unmodified from the pinned commit. `./serve.py`
adds only the three things a library has no reason to carry and a public service does: it moves
the backbone load into a background thread so the health gate is not waiting on a 9.3 GB download,
it turns `/health` into a 503 if that load fails so a broken service cannot pass the gate, and it
puts an API key in front of everything except `/health`.

## What you get by hosting it

- **Your states stay in your project.** Tickets, emails and documents are scored on your own
  machine rather than posted to a model vendor.
- **No per-token bill.** You pay for a running container, which is the difference that matters
  when the job is "label every inbound message". See [FAQ](#faq) for what always-on costs.
- **A `/v1/systemone` endpoint** on an HTTPS URL, behind an API key of your choosing, that any
  TypeSafe client can use unchanged by pointing its base URL here.
- **Interactive OpenAPI docs at `/docs`**, where you can compose a request and send it without
  writing a client. They are the only UI this API has, and `/` redirects there.
- **The weights kept on the volume.** The released adapter, head and calibration profile are
  fetched at first boot, so a restart re-maps them from disk instead of re-downloading 9.5 GB.

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
| `LEV_CHECKPOINT` | preset | `interfaze-ai/lev`, the released adapter. Set to your own release directory or Hub id to serve that instead, or clear it to serve the untrained backbone. |

Set by the template, not by you: `HF_HOME=/data/hf` (the Hub cache on the volume, which is what
makes a restart cheap), `OMP_NUM_THREADS=8` (the platform's compute ceiling is 8 shared vCPUs and a
forward pass here is CPU-bound across all of them), `PORT=8080`, and `USE_TF=0` / `USE_TORCH=1` /
`TOKENIZERS_PARALLELISM=false`, which keep transformers from probing for TensorFlow at import.

## After deploy

**On the deployment this was measured on, the service was answering 25 seconds after boot**,
including the 9.5 GB fetch from the Hugging Face Hub, of which the two backbone shards took 11
seconds. Treat that as the good case rather than a promise: it is one measurement on one machine,
and it depends on how fast the Hub serves you.

The deploy goes green before the fetch finishes, which is deliberate rather than a lie: `/health`
answers 200 with `{"status": "loading"}` from the moment the socket binds, and `/v1/systemone`
answers 529 until the weights are mapped. Watch `/status`, which reports `loading`, `ready` or
`failed` and how long the load took. A restart is slower than that first boot, not faster: see the
FAQ.

Once `/status` reports `ready`, ask it something:

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

What comes back, from a real run against a deployed instance (probabilities rounded here, the
service returns full precision):

```json
{
  "model": "Qwen/Qwen3.5-4B",
  "answers": {
    "intent": {
      "type": "choice",
      "choice": "refund",
      "probabilities": {"refund": 0.802, "cancel": 0.076, "track": 0.010, "other": 0.112},
      "confidence": 0.548
    },
    "urgent": {
      "type": "noul",
      "noul": 0.401,
      "probabilities": {"0": 0.160, "1": 0.119, "2": 0.152, "3": 0.169, "4": 0.104,
                        "5": 0.094, "6": 0.080, "7": 0.066, "8": 0.056},
      "confidence": 0.016
    }
  },
  "usage": {"input_tokens": 224, "output_tokens": 0, "cached_input_tokens": 69}
}
```

`answers.intent.choice` is the picked option and `probabilities` is the distribution over exactly
the options you supplied. `answers.urgent.noul` is the probability the answer is yes, read off a
nine-bucket rating. `usage.output_tokens` is `0`, which is the claim the whole model rests on. Act
on the numbers in your own code. The thresholds are yours, not the model's.

Or open `/docs` in a browser. It prompts for credentials: the username is `api` and the password is
your `API_KEY`.

`GET /health` needs no credential, because the platform's deploy gate fetches it from outside and
has none. It reports liveness and the loaded checkpoint, never a decision.

## Limits

Upstream's own, from the [model card](https://huggingface.co/interfaze-ai/lev):

- **English only.**
- **A GPU is what upstream recommends for real-time use.** On CPU, in their words, "a 4B backbone
  there takes seconds per call, not milliseconds". This template is CPU only, and that is the
  4 to 6 seconds you see. If you need millisecond decisions, this is the wrong deployment.
- **Calibration is fitted on the training distribution.** A task very unlike the training mix may
  be less well calibrated. Check on your own data before you gate on the probabilities.
- **Minimal edits and fine-grained ratings are weak.** Inputs that differ by one swapped word or
  number, and quality ratings over five levels, are where lev is least accurate and where it can
  be confidently wrong.
- **Questions are answered independently.** Answers in one request do not condition on each other.

This template's own:

- **amd64 only.** The aarch64 wheels exist, but nobody has run a 4B bf16 forward pass on arm64
  here, so the manifest declares one architecture rather than guessing at two.
- **The first request after a restart can be cut off.** See the FAQ below.
- **Always-on, and billed around the clock.** See the FAQ below.

## FAQ

**Why is the first request after a restart so slow, or cut off entirely?**
The forward pass has to fault 9.3 GB of weights in off the disk. Measured across two restarts of
the same deployment, that first decision took 36 seconds on one and more than 60 on the other. The
edge in front of the service cuts a connection at 60 seconds and returns a 502, so on the second
restart it was cut. Send that first request yourself once `/status` reports `ready`, expect it to
be slow or cut, and do not point real traffic at a restarted service until a request has come back.
The pages stay warm afterwards, and every decision after the first took 4 to 6 seconds, measured at
4.5 to 4.6 seconds over four consecutive requests.

**Does it stop when nobody is using it?**
No, and it cannot. An idle volume-bearing compute service is stopped, so the next request would pay
a cold start plus a fresh map of the backbone. Boot to a loaded engine is 65 to 69 seconds and the
first decision after that has exceeded 60 seconds on its own, so scale-to-zero would cut off every
first request after an idle period. The service is always-on and charged the whole time. Delete it
when you are done with it.

**How does a 9.3 GB model fit on a machine with an 8 GB ceiling?**
It is not resident. Safetensors loads the weights zero-copy from a memory map, so they are clean
file-backed pages the kernel reclaims under pressure. During serving the process reported an 11 GB
mapping and about 620 MB actually resident, and the platform reported 1.7 GB used of 8 GB while it
was answering. The cost shows up as I/O instead, which is what the slow first request after a
restart is.

**Why does the deploy go green before the service can answer?**
Because the alternative is worse. `/health` answers 200 from the moment the socket binds, so a
first deploy passes its 90-second gate while it is still fetching 9.5 GB. If the load then fails,
`/health` turns into a 503 and the deploy fails rather than leaving a green deploy in front of a
service that can never answer.

**Why is the API key not generated for me?**
A generated value would be stored write-only and you could never read it back. The deploy form
starts the field empty on purpose: paste a key of your choosing and keep a copy.

**Why is there a volume?**
For the Hugging Face cache, and nothing else. It holds 8.9 GiB of backbone, adapter and Mode B
head, fetched once per deployment instead of once per restart. A decision is state in, answer out,
so nothing else is written between requests.

**Is this compatible with Jev?**
The wire protocol is, so a TypeSafe client works by changing its base URL. The model is not Jev.
Not affiliated with or endorsed by TypeSafe.

## Links

- Upstream: <https://github.com/Abhinavexists/lev>, pinned at commit
  `cf104b69329302e4eac674a730c71f3511047db8` (the repository publishes no releases and no tags, so
  the commit is the pin). The PyPI name `lev` is an unrelated placeholder package and is not used.
- Weights: <https://huggingface.co/interfaze-ai/lev>, on `Qwen/Qwen3.5-4B`
- Benchmarks: <https://github.com/Abhinavexists/lev/blob/main/docs/FINDINGS.md>
- Image: `ghcr.io/insforge/insta-oss/templates/lev`, built from `./Dockerfile`
- License: Apache-2.0 (upstream `Abhinavexists/lev`, and the adapter weights). The backbone is
  Qwen's, under its own licence.
