# Laya

An open-source alternative to Jev. If you do not want a proprietary decision model, self-host this one and call the API: typed yes/no, choice and score decisions with probabilities, on CPU, in your own project.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://console.instacloud.com/templates/laya)

## What it does

[Laya](https://github.com/NandhaKishorM/laya) is a non-autoregressive decision engine. You POST a piece of state — an email, a ticket, a support message, a JSON object — together with typed questions, and it answers each one in a single forward pass.

- `choice` — picks one of your options, with a probability for each
- `score` — an expected value over an ordered scale
- `noul` — the probability that something is true

**No text is generated**, so there is nothing to parse and no format to repair. Typical uses: routing tickets, classifying email, scoring urgency, gating an LLM call.

Jev is TypeSafe AI's proprietary decision model. Laya gives you the same three primitives with an open Apache-2.0 model, on hardware you control. Different wire format, and not affiliated with or endorsed by TypeSafe.

## Why run it yourself

- **Your data stays in your project.** Tickets, emails and documents are scored on your own machine, not posted to a model vendor.
- **No per-token bill.** You pay for a running container, which is the difference that matters when the job is "label every inbound message".
- **Nothing is downloaded at runtime.** The 842 MB checkpoint is baked into the image and the container never reaches the Hugging Face Hub, so what you deploy is what was built and tested.
- **Interactive docs at `/docs`**, where you can compose a request and send it without writing a client.

## Deploy

1. Paste an **API key** of your choosing. That is the only input; nothing to download.
2. Click Deploy. The service is live in about **2 minutes**.
3. Most of that is the model loading. `/decide` answers 503 until it finishes, and `/healthz` says when.

## Use it

```bash
curl -X POST https://YOUR-SERVICE-URL/decide \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" -d '{
  "state": "We were billed twice for March. Refund it today or we cancel.",
  "questions": [
    {"type": "choice", "instructions": "Which department?", "options": ["billing", "technical", "sales"]},
    {"type": "score", "instructions": "How urgent?", "options": ["not urgent", "soon", "blocking"]},
    {"type": "noul", "instructions": "Does the user threaten to cancel?"}
  ]}'
```

Each answer carries its probabilities and a `confidence`; the response carries `latency_ms`.
Basic auth sends the same secret in RFC 7617 form: `curl -u api:YOUR_API_KEY ...` (the username is
always `api`). Prefer a browser? Open the service URL, sign in as `api` with your key, and the
interactive docs let you run the same request from **Try it out**.

```json
{"answers": [
  {"type": "choice", "choice": "billing", "probabilities": {"billing": 0.86, "technical": 0.06, "sales": 0.08}},
  {"type": "score", "score": 1.73, "legend": {"0": "not urgent", "1": "soon", "2": "blocking"}},
  {"type": "noul", "noul": 0.76}
], "latency_ms": 321.9}
```

Act on the numbers in your own code. The thresholds are yours, not the model's.

`GET /healthz` needs no credential and reports `model_loaded`. Poll it if you are scripting against the service.

## Configuration

| Variable | Required | What it is |
|---|---|---|
| `API_KEY` | yes | The key for every route except `/healthz`. **Rotate it by redeploying with a new value.** |

Everything else is set for you.

## Limits

- **Input past ~1K tokens is silently truncated.** Keep states short.
- **English only.** The original project's multilingual checkpoint is not in this template.
- **`confidence` is miscalibrated**, by the original authors' own ECE numbers. Rank by it; do not read it as a probability of being right.
- **amd64 only.**

The first is the deployment fork's measured finding (`deploy/DEPLOY-CLOUD.md`); the third is the original authors' (`BENCHMARKS.md`).

## FAQ

**Is this compatible with Jev's API?**
No. Same three primitives, different wire format. Not affiliated with or endorsed by TypeSafe.

**Why is the first call slow?**
The 842 MB checkpoint loads into memory on boot. It is baked into the image, so nothing is downloaded; the wait is the load itself. It happens once per boot, so only a restart or a redeploy pays it again.

**Does it stop when nobody is using it?**
No. It stays up, so a request never waits for a boot. That also means it is charged the whole time; delete the service when you are done with it.

**Why is the API key not generated for me?**
A generated value would be stored write-only and you could never read it back. The deploy form starts the field empty on purpose: paste a key of your choosing.

**Why is there no volume?**
Nothing is written between requests. A request carries the state it asks about.

**Which checkpoint is this?**
`typed-decisions`, ModernBERT-large, 421M parameters, 1024-token context - built by Convai Innovations, the original Laya authors. The one the deployment fork's `deploy/` directory ships.

## Links

- Original project: [Laya](https://github.com/NandhaKishorM/laya) by **Convai Innovations**, who
  built and trained the model; model card on
  [Hugging Face](https://huggingface.co/convaiinnovations/laya)
- Deployment source: <https://github.com/tonychang04/laya-template>, pinned to `c9dcaab` (packages
  the original project's model behind a deploy directory of its own)
- License: Apache-2.0
