# An overlay, not a fork: the repository ships no image and its only published artifact is a
# source package, so this installs `lev` from the pinned commit and adds the two things a public
# service needs that the library has no reason to carry (see serve.py).
#
# The PyPI name `lev` is NOT this project. It is an unrelated 0.0.1 placeholder with the one-word
# summary "lev", so the install goes through the repository URL and a commit, never the index.
FROM python:3.12-slim-bookworm

# git only, and only to fetch the pinned commit. Everything else is a wheel.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# USE_TF/USE_TORCH: transformers probes for TensorFlow at import and its abseil runtime can
# deadlock model construction; laya's image sets the same pair for the same reason, and lev is
# torch-only too. HF_HOME points at the volume so the 9.3 GB backbone is fetched once per
# deployment rather than once per restart; repeated in the manifest so it is visible in the console.
ENV USE_TF=0 \
    USE_TORCH=1 \
    TOKENIZERS_PARALLELISM=false \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/data/hf

# The CPU wheel index. Without it pip resolves the CUDA build, which is several GB of kernels a
# compute machine with no GPU would never execute.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.14.0

# Pinned to exactly what upstream pins in its own modal/app.py, which is the only environment the
# released weights have ever been served under. transformers MUST be 5.x: the backbone is a hybrid
# linear-attention model and the prefix-cache fork calls `reorder_cache` on a hybrid cache, which
# 4.x cannot do. uvicorn is this file's addition; upstream's `lev[serve]` extra names it unpinned.
RUN pip install --no-cache-dir \
        transformers==5.17.0 \
        accelerate==1.15.0 \
        peft==0.21.0 \
        safetensors==0.8.0 \
        huggingface-hub==1.32.0 \
        pydantic==2.13.5 \
        fastapi==0.141.1 \
        uvicorn==0.34.0

# upstream pin: keep in sync with insta.template.yaml (upstream.commit). The repository publishes
# no releases and no git tags, so the commit IS the pin.
#
# --no-deps because the pins above are the whole dependency set for serving: `lev[serve]` also
# names `datasets`, which only `lev data build` uses, and resolving the extra would let pip move
# the four version pins that matter.
ARG LEV_COMMIT=cf104b69329302e4eac674a730c71f3511047db8
RUN pip install --no-cache-dir --no-deps \
        "lev @ git+https://github.com/Abhinavexists/lev@${LEV_COMMIT}#subdirectory=packages/lev"

COPY serve.py /opt/serve.py
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Prove the wiring before the build may succeed. This imports serve.py exactly as uvicorn will,
# which builds the app, moves upstream's startup hook aside and registers the auth middleware, so
# a rename or a signature change upstream turns the build red instead of the deploy. It stays
# cheap because no weight is touched: `lev.model.load` imports torch lazily and only the startup
# hook calls it, and this never starts that thread.
RUN API_KEY=smoke-test-only python -c "import sys; sys.path.insert(0, '/opt'); import serve; print('serve.py OK:', serve.app.title)"

WORKDIR /opt
ENV PORT=8080
EXPOSE 8080
CMD ["/entrypoint.sh"]
