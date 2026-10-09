"""Build step: cache the checkpoint into the image, then make it answer once.

Run by the Dockerfile, never at runtime. Two things ride on it.

**The cache has to be the one the service reads.** The load call below is the one
`deploy/app.py` makes, character for character. The Hub keys its cache on the repo id and the
downloaded patterns, so a near miss here (a different subfolder, the sibling `multilingual`
checkpoint, a shortened repo id) still builds a perfectly good image whose cache the service then
misses. With `HF_HUB_OFFLINE=1` that miss is a hard failure at boot; without it, an 842 MB download
on first request. Calling the same function is what makes those two impossible.

**A download proves nothing.** This repository pins neither `torch` nor `transformers`, so the
build resolves both to whatever is current on the day it runs, against a ModernBERT encoder built
through `AutoModel.from_config`. A release that breaks the encoder or the decision head should turn
this build red, where it is one line of log, rather than reach a deployed service and surface as
`/decide` returning 503 to someone who has no reason to suspect the library.

The assertion is deliberately about shape, not about which answer comes back: this is a check on
the plumbing, and locking a build to one model output would make an upstream retrain look like a
broken image.
"""

import laya

QUESTIONS = {
    "department": {
        "type": "choice",
        "instructions": "Which department should handle this request?",
        "criteria": {"billing": "invoices, payments, refunds", "technical": "bugs, outages, errors"},
    },
    "urgent": {"type": "noul", "instructions": "Is this urgent?"},
}

agent = laya.load("convaiinnovations/laya", subfolder="typed-decisions")
result = agent.predict("The checkout endpoint has been returning 502s for an hour.", QUESTIONS)

answers = result["answers"]
assert set(answers) == set(QUESTIONS), answers
assert answers["department"]["choice"] in QUESTIONS["department"]["criteria"], answers
assert 0.0 <= answers["urgent"]["noul"] <= 1.0, answers
print(f"smoke: department={answers['department']['choice']} urgent={answers['urgent']['noul']}")
