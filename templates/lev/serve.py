"""Upstream's own FastAPI app, with the backbone load taken off the boot path and a key in front.

`lev.server.create_app` is imported and its routes are left alone: `/v1/systemone`, `/health` and
the request and response models are all upstream's, so a moving pin moves the contract with it and
nothing here has to be re-synced by hand. This file adds three things the library has no reason to
carry but a service on a public URL does.

  * **The load runs in a background thread.** Upstream registers it as FastAPI's startup hook, so
    the socket does not open until the 9.3 GB bf16 backbone has been fetched from the Hub and
    mapped. The platform's template health gate wants a 2xx on the declared path within 90 seconds
    and a first boot spends far longer than that downloading. The app already has the states for
    this: with `engine` still None, `/health` answers 200 with `{"status": "loading"}` and
    `/v1/systemone` answers 529, so moving the hook off the boot path is the whole change.

  * **A load failure is reported as one.** The consequence of the line above is that a load which
    raises would otherwise leave `/health` answering "loading" forever, which the gate reads as a
    healthy deploy: a green deploy in front of a service that can never answer. The middleware
    turns `/health` into a 503 once the thread has failed, so the gate fails the way it should and
    the reason is in the body rather than only in the log.

  * **A credential.** One `/v1/systemone` call is a forward pass through a 4B model, so an open
    endpoint is a compute faucet for whoever finds the URL. Upstream ships no authentication and
    documents fronting the server with some (`LEVBENCH_LOCAL_API_KEY` in its `.env.example`).
    `/health` stays open because the gate fetches it from outside and holds no credential; it
    reports liveness only, never a decision.
"""

import base64
import binascii
import os
import secrets
import threading
import time
import traceback

from fastapi.responses import JSONResponse, RedirectResponse

from lev.server import create_app

# No fallback. The manifest declares it required with neither a default nor a generator, so the
# platform always supplies it; a missing one means the image was started some other way, and
# inventing a value would put an open inference endpoint on a public URL.
API_KEY = os.environ["API_KEY"]

# The fixed basic-auth username, matching laya's. It carries no secret, so asking an operator to
# pick one would be a form field with no decision behind it. Clients that prefer plain API-key
# style skip basic auth and send `Authorization: Bearer <key>`; a TypeSafe SDK client points its
# `api_key` at the same value.
USERNAME = "api"

# Fetched by the platform's health gate, which has no credential and would read a 401 as a failed
# deploy. Every other path, `/docs` included, is behind the key.
OPEN_PATHS = frozenset({"/health"})

# A release directory, a Hub id, or empty to serve the untrained backbone. Read from the
# environment rather than hardcoded so an operator can repoint it from the console without a new
# image; the manifest carries the default under env.fixed, where it is visible and editable.
CHECKPOINT = os.environ.get("LEV_CHECKPOINT", "").strip() or None

app = create_app(checkpoint_dir=CHECKPOINT)

# Progress the loading thread publishes and `/status` reads. Plain assignment under the GIL: one
# writer, and readers tolerate a stale field.
_load = {"state": "loading", "error": None, "seconds": None, "checkpoint": CHECKPOINT}

# Upstream's startup hook, lifted out of the boot path. Taken as a list rather than by name because
# what matters is that nothing is left to run before the socket binds, whatever upstream registers.
_hooks = list(app.router.on_startup)
app.router.on_startup.clear()


def _load_weights() -> None:
    started = time.monotonic()
    try:
        for hook in _hooks:
            hook()
    except BaseException as exc:  # noqa: BLE001 - the thread is the only place this can surface
        _load["error"] = f"{type(exc).__name__}: {exc}"
        _load["state"] = "failed"
        _load["seconds"] = round(time.monotonic() - started, 1)
        # The deploy log is where an operator looks first, and `insta compute logs` is how the
        # cause of a failed template deploy is read at all.
        print(f"lev: model load FAILED after {_load['seconds']}s", flush=True)
        traceback.print_exc()
        return
    _load["seconds"] = round(time.monotonic() - started, 1)
    _load["state"] = "ready"
    print(f"lev: model ready in {_load['seconds']}s (checkpoint {CHECKPOINT})", flush=True)


@app.on_event("startup")
def _start_loading() -> None:
    threading.Thread(target=_load_weights, name="lev-load", daemon=True).start()


def _unauthorized() -> JSONResponse:
    """A fresh response per request: a shared one is a single object every worker task mutates."""
    return JSONResponse(
        {"error": "authentication required"},
        status_code=401,
        # Without this header a browser never prompts, so the docs page would be unreachable
        # rather than merely locked.
        headers={"WWW-Authenticate": 'Basic realm="lev", charset="UTF-8"'},
    )


def _authorized(header: str) -> bool:
    scheme, _, encoded = header.partition(" ")
    scheme = scheme.lower()
    if scheme == "bearer":
        return secrets.compare_digest(encoded.strip().encode("utf-8"), API_KEY.encode("utf-8"))
    if scheme != "basic":
        return False
    try:
        supplied = base64.b64decode(encoded, validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return False
    user, sep, password = supplied.partition(":")
    if not sep:
        return False
    # Both compares always run and neither short-circuits on the first wrong byte: `and` would
    # leak whether the username alone was right through the response time. Compared as bytes
    # because compare_digest on str raises TypeError for non-ASCII, which would turn any non-ASCII
    # credential into a 500 instead of a 401.
    ok_user = secrets.compare_digest(user.encode("utf-8"), USERNAME.encode("utf-8"))
    ok_password = secrets.compare_digest(password.encode("utf-8"), API_KEY.encode("utf-8"))
    return ok_user & ok_password


@app.middleware("http")
async def api_key_auth(request, call_next):
    if request.url.path in OPEN_PATHS:
        if _load["state"] == "failed":
            # See the module docstring: without this the gate reads a permanently loading service
            # as a healthy one.
            return JSONResponse(
                {"status": "failed", "error": _load["error"]},
                status_code=503,
            )
        return await call_next(request)
    if _authorized(request.headers.get("authorization", "")):
        return await call_next(request)
    return _unauthorized()


@app.get("/status", include_in_schema=False)
def status() -> dict:
    """How far the load got, which `/health` cannot say: it only knows engine or no engine.

    Behind the key, unlike `/health`, because the error string it carries is a stack-derived
    message about the inside of the container.
    """
    return dict(_load)


@app.get("/", include_in_schema=False)
def index():
    """Send a browser to the interactive docs, which are the only UI this API has."""
    return RedirectResponse("/docs")
