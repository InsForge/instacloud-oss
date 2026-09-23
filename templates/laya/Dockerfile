# Laya's own deploy/Dockerfile, adapted to this platform: the build context here is
# templates/laya/, not the upstream checkout, so the source arrives by pinned clone instead of a
# COPY, and the CMD goes through an entrypoint that refuses to start without a credential.
FROM python:3.12-slim

# git only, and only to fetch the pinned commit. Everything else the app needs is a wheel.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# transformers probes for TensorFlow at import and its abseil runtime can deadlock model
# construction; upstream's CI sets the same two for the same reason. Declared here as well as in
# the manifest so the build's own smoke test runs under the environment the service will.
ENV USE_TF=0 \
    USE_TORCH=1 \
    TOKENIZERS_PARALLELISM=false \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/opt/hf

# The CPU wheel index, which is what makes this image ~1 GB of torch instead of ~6 GB of CUDA that
# a compute machine with no GPU would never use. Upstream's Dockerfile and CI both do this.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir fastapi uvicorn

# upstream pin: keep in sync with insta.template.yaml (upstream.commit). A tag would be the nicer
# reference, but the repository publishes none, and the branch tip is not a pin.
ARG LAYA_COMMIT=c9dcaab6da74ce5c34a66ef84f2503c77e4e619a
RUN git clone --filter=blob:none https://github.com/tonychang04/laya-template.git /opt/laya-src \
 && git -C /opt/laya-src checkout --detach "$LAYA_COMMIT" \
 && rm -rf /opt/laya-src/.git \
 && pip install --no-cache-dir /opt/laya-src

# Bake the checkpoint into the image and prove the stack answers, both before the build may
# succeed. See bake.py for why this is a real prediction and not just a download.
COPY bake.py /opt/bake.py
RUN python /opt/bake.py

COPY serve.py /opt/serve.py
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /opt
ENV PORT=8080
EXPOSE 8080
CMD ["/entrypoint.sh"]
