#!/bin/sh
# Exists for exactly one thing: the four pyannote Community-1 checkpoints that turn on speaker
# labels. Everything else about starting the server is argv, which the ENTRYPOINT could carry on
# its own.
#
# Those four cannot be baked into the image the way the Whisper model is. The pyannote repository
# is gated (CC BY 4.0 plus access conditions accepted per Hugging Face account), an anonymous fetch
# gets 401 GatedRepo, and redistributing them from a public image is not this template's to do. So
# the operator supplies a token, this fetches 33 MB onto the volume once, and every later restart
# finds them already there.
#
# Without HF_TOKEN nothing here runs and the server starts exactly as it would have without this
# script: transcription works, and a diarized request answers 503 naming what is missing.
set -eu

MODEL="/opt/whisper-turbo/turbo-q8.whtrbo"
DIAR_DIR="/data/community-1"
DIAR_REPO="pyannote/speaker-diarization-community-1"
# The revision upstream's docs/diarization.md pins, with the four checksums from the same page.
# Upstream's reader accepts these exact uncompressed ZIP checkpoints, so the revision is as much
# part of the pin as the content is.
DIAR_REVISION="3533c8cf8e369892e6b79ff1bf80f7b0286a54ee"
# remote-path:local-name:sha256, one per line, split on whitespace by the loops below. Deliberately
# not piped into `while read`: a pipeline puts the loop in a subshell, where a failure return could
# not reach the caller and a broken download would look like a successful one.
DIAR_FILES="segmentation/pytorch_model.bin:segmentation-pytorch_model.bin:7ad24338d844fb95985486eb1a464e32d229f6d7a03c9abe60f978bacf3f816e
embedding/pytorch_model.bin:embedding-pytorch_model.bin:6f10ff60898a1d185fa22e1d11e0bfa8a92efec811f11bca48cb8cafebefd929
plda/xvec_transform.npz:plda-xvec_transform.npz:325f1ce8e48f7e55e9c8aa47e05d2766b7c48c4b25b8de8dd751e7a4cc5fbe8f
plda/plda.npz:plda-plda.npz:9b77bcd840692710dd3496f62ecfeed8d8e5f002fd991b785079b244eab7d255"

digest() { sha256sum "$1" | cut -d' ' -f1; }

fetch_diarization() {
    mkdir -p "$DIAR_DIR"
    for entry in $DIAR_FILES; do
        remote="${entry%%:*}"
        rest="${entry#*:}"
        name="${rest%%:*}"
        want="${rest##*:}"
        target="$DIAR_DIR/$name"
        if [ -s "$target" ] && [ "$(digest "$target")" = "$want" ]; then
            continue
        fi
        echo "[entrypoint] fetching $name" >&2
        curl -fsSL --retry 3 -H "Authorization: Bearer ${HF_TOKEN:-}" \
            -o "$target.part" \
            "https://huggingface.co/$DIAR_REPO/resolve/$DIAR_REVISION/$remote" || return 1
        if [ "$(digest "$target.part")" != "$want" ]; then
            rm -f "$target.part"
            echo "[entrypoint] $name failed its SHA-256 check" >&2
            return 1
        fi
        mv "$target.part" "$target"
    done
}

have_diarization() {
    for entry in $DIAR_FILES; do
        rest="${entry#*:}"
        name="${rest%%:*}"
        [ -s "$DIAR_DIR/$name" ] || return 1
    done
}

if [ -n "${HF_TOKEN:-}" ]; then
    # A bad token must not become a crash loop. The machine would restart, fail identically, never
    # reach the health gate, and read as "this template is broken" rather than "that token is
    # wrong". Transcription does not need these files, so the service comes up either way, the
    # reason is in the logs, and a diarized request says so too.
    if fetch_diarization; then
        echo "[entrypoint] diarization checkpoints ready in $DIAR_DIR" >&2
    else
        echo "[entrypoint] could not fetch the Community-1 checkpoints. Check that HF_TOKEN is valid and that its account has accepted the conditions on $DIAR_REPO. Starting without diarization; transcription is unaffected." >&2
    fi
fi

# Read from what is actually on disk rather than from whether the fetch ran, so hand-placed files
# work exactly like fetched ones and a half-finished download is never handed to the server.
if have_diarization; then
    WHISPER_DIARIZATION_MODELS="$DIAR_DIR"
    export WHISPER_DIARIZATION_MODELS
else
    echo "[entrypoint] no diarization checkpoints; transcription only, diarized requests answer 503" >&2
fi

# Port and bind address stay literal. 8080 is what the manifest routes and there is no reason a
# deploy would want them to disagree. "::" is upstream's dual-stack listener, which is what this
# platform's IPv6-only edge reaches; upstream's own comment in src/server/http.c names it.
# Binding non-loopback makes WHISPER_API_KEY mandatory upstream-side and the server says so on
# stderr if it is missing, so there is no guard for it here.
exec /usr/local/bin/whisper-turbo-server "$MODEL" 8080 "::"
