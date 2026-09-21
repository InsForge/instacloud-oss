"""HTTP basic auth in front of the repository's own deploy/app.py, and a landing route.

Everything about the decision contract (`POST /decide`, the question types, the background
checkpoint load, `GET /healthz`) is upstream's and is imported unmodified. This file adds the two
things the upstream app has no reason to carry but a service on the public internet does:

  * a credential, because the cheapest /decide request is a few hundred milliseconds of CPU and an
    open endpoint is a compute faucet for whoever finds the URL;
  * a route at `/`, because upstream declares none and a reviewer opening the service URL would
    otherwise get a bare 404 rather than the interactive docs.

/healthz stays open: the platform's deploy gate fetches it from outside and has no credential.
It reports liveness and load progress only, never a decision.
"""

import base64
import binascii
import os
import secrets
import sys

from fastapi.responses import JSONResponse, RedirectResponse

# The upstream application, from the clone the Dockerfile pinned. Importing it (rather than copying
# it here) is what keeps this file a shell: when the pinned commit moves, the contract moves with it
# and nothing in this directory has to be re-synced by hand.
sys.path.insert(0, "/opt/laya-src/deploy")
from app import app  # noqa: E402

# No fallbacks. The manifest declares both required with neither a default nor a generator, so the
# platform always supplies them; a missing one means the image was started some other way, and
# inventing a value would put an open inference endpoint on a public URL.
USERNAME = os.environ["ADMIN_USERNAME"]
PASSWORD = os.environ["ADMIN_PASSWORD"]

if ":" in USERNAME:
    # RFC 7617 joins the pair with a colon and the server splits on the FIRST one, so a username
    # containing one can never be typed back correctly. Stop here rather than ship a service whose
    # own operator is locked out with a 401 and nothing in the logs.
    raise SystemExit("ADMIN_USERNAME must not contain a colon: HTTP basic auth splits on it")

# Fetched by the platform's health gate, which has no credential and would otherwise read the 401
# as a failed deploy.
OPEN_PATHS = frozenset({"/healthz"})

def _unauthorized() -> JSONResponse:
    """A fresh response per request: a shared one is a single object every worker task mutates."""
    return JSONResponse(
        {"error": "authentication required"},
        status_code=401,
        # Without this header the browser never prompts, so the docs page would be unreachable
        # rather than merely locked.
        headers={"WWW-Authenticate": 'Basic realm="laya", charset="UTF-8"'},
    )


def _authorized(header: str) -> bool:
    scheme, _, encoded = header.partition(" ")
    if scheme.lower() != "basic":
        return False
    try:
        supplied = base64.b64decode(encoded, validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return False
    user, sep, password = supplied.partition(":")
    if not sep:
        return False
    # Both compares always run, and neither short-circuits on the first wrong byte: `and` would
    # leak whether the username alone was right through the response time.
    # bytes form: compare_digest on str raises TypeError for non-ASCII, turning any
    # non-ASCII credential (sent or configured) into a 500 instead of a 401.
    ok_user = secrets.compare_digest(user.encode("utf-8"), USERNAME.encode("utf-8"))
    ok_password = secrets.compare_digest(password.encode("utf-8"), PASSWORD.encode("utf-8"))
    return ok_user & ok_password


@app.middleware("http")
async def basic_auth(request, call_next):
    if request.url.path in OPEN_PATHS:
        return await call_next(request)
    if _authorized(request.headers.get("authorization", "")):
        return await call_next(request)
    return _unauthorized()


@app.get("/", include_in_schema=False)
def index():
    """Send a browser to the interactive docs, which are the only UI this API has."""
    return RedirectResponse("/docs")
