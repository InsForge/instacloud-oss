# Laya

An open-source alternative to Jev: typed decisions with calibrated probabilities, on CPU, in your own project.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://console.instacloud.com/templates/laya)

## What it does

You POST a piece of state and a list of typed questions. You get one answer per question, in one forward pass. No text is generated, so there is nothing to parse.

- `choice` — picks one of your options, with a probability for each
- `score` — an expected value over an ordered scale
- `noul` — the probability that something is true

Typical uses: **routing tickets, classifying email, scoring urgency, gating an LLM call**.

## Deploy

1. Pick a **username** and **password**. That is the only input; there is no API key and nothing to download.
2. Click Deploy. The service is live in about **2 minutes**.
3. Most of that is the model loading. `/decide` answers 503 until it finishes, and `/healthz` says when.

## Use it

1. Open your service URL. The browser asks for the credentials you set, then shows the API docs.
2. Expand `POST /decide`, click **Try it out**, and paste:

```json
{
  "state": "We were billed twice for March. Refund it today or we cancel.",
  "questions": [
    {"type": "choice", "instructions": "Which department?", "options": ["billing", "technical", "sales"]},
    {"type": "score", "instructions": "How urgent?", "options": ["not urgent", "soon", "blocking"]},
    {"type": "noul", "instructions": "Does the user threaten to cancel?"}
  ]
}
```

3. Read the answers. Each carries its probabilities and a `confidence`; the response carries `latency_ms`.

```json
{"answers": [
  {"type": "choice", "choice": "billing", "probabilities": {"billing": 0.86, "technical": 0.06, "sales": 0.08}},
  {"type": "score", "score": 1.73, "legend": {"0": "not urgent", "1": "soon", "2": "blocking"}},
  {"type": "noul", "noul": 0.76}
], "latency_ms": 321.9}
```

4. Act on the numbers in your own code. The thresholds are yours, not the model's.

`GET /healthz` needs no credential and reports `model_loaded`. Poll it if you are scripting against the service.

## Configuration

| Variable | Required | What it is |
|---|---|---|
| `ADMIN_USERNAME` | yes | Username for the API. No colon. |
| `ADMIN_PASSWORD` | yes | Password for the API. **Change it after deploying.** |

Everything else is set for you.

## Speed and cost

| | |
|---|---|
| One question, warm | **72 ms** |
| Three questions, warm | **320 ms** |
| First call after a restart | **about 45 s**, while the model loads |
| Memory | 2.2 GB |
| Billing | **continuous.** The machine is always on, so it is charged from deploy until you delete the service |

Latency grows with the length of the state, roughly 1.1 ms per input token.

## Limits

- **Input past ~1K tokens is silently truncated.** Keep states short.
- **English only.** Upstream's multilingual checkpoint is not in this template.
- **`confidence` is miscalibrated.** Rank by it; do not read it as a probability of being right.
- **amd64 only.**

## FAQ

**Is this compatible with Jev's API?**
No. Same three primitives, different wire format. Not affiliated with or endorsed by TypeSafe.

**Why is the first call slow?**
The 842 MB checkpoint loads into memory on boot. It is baked into the image, so nothing is downloaded; the wait is the load itself. It happens once per boot, so a restart or a redeploy pays it again.

**Why are the credentials not generated for me?**
A generated value would be stored write-only and you could never read it back. The deploy form starts them empty on purpose.

**Why is there no volume?**
Nothing is written between requests. A request carries the state it asks about.

**Which checkpoint is this?**
`typed-decisions`, ModernBERT-large, 421M parameters, 1024-token context. The one upstream's own deploy directory ships.

## Links

- Upstream: <https://github.com/tonychang04/laya-template>, pinned to `c9dcaab`
- Model: <https://huggingface.co/convaiinnovations/laya>
- License: Apache-2.0
