# Base pinned by digest. This is the top-level OCI index digest, not a child manifest's, so a
# future arm64 build would still resolve (see meta.architectures in insta.template.yaml for why
# the manifest declares amd64 only today).
FROM python:3.11-slim-bookworm@sha256:528257d48c1da0dcecc2e725d1ae34498d60c965f1241e39cd6a85a8859bdf84

# ffmpeg is not optional and not a convenience: whisper/audio.py shells out to the `ffmpeg` binary
# to decode and resample every input, so without it the tool installs cleanly and then fails on
# the first file with a FileNotFoundError that says nothing about ffmpeg.
# curl and wget are how a user gets audio INTO this box, git and procps are ordinary shell tools.
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash ffmpeg git ca-certificates curl wget procps less \
    && rm -rf /var/lib/apt/lists/*

# ttyd: browser terminal over HTTPS, and the long-running process this service is built around.
# whisper is a CLI that transcribes a file and exits; ttyd is what owns the port and survives it.
ARG TTYD_VERSION=1.7.7
# Pinned checksums of the ttyd 1.7.7 release binaries: a tampered or swapped asset fails the build.
ARG TTYD_SHA256_X86_64=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
ARG TTYD_SHA256_AARCH64=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165
RUN arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) ttyd_arch=x86_64;  ttyd_sha="$TTYD_SHA256_X86_64" ;; \
        arm64) ttyd_arch=aarch64; ttyd_sha="$TTYD_SHA256_AARCH64" ;; \
        *)     echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}" \
        -o /usr/local/bin/ttyd \
    && echo "${ttyd_sha}  /usr/local/bin/ttyd" | sha256sum -c - \
    && chmod +x /usr/local/bin/ttyd

# CPU-only torch, from PyTorch's own cpu index. This is the whole reason the image is ~1.5 GB
# instead of ~6 GB: the default PyPI wheel drags in the bundled CUDA runtime and the nvidia-*
# packages, none of which a machine with no GPU can use. The cpu index also serves torch's own
# dependencies, which is why it is --index-url and not --extra-index-url: mixing the two lets the
# resolver prefer PyPI's CUDA build again.
ARG TORCH_VERSION=2.9.1
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
        "torch==${TORCH_VERSION}"

# upstream pin: keep in sync with insta.template.yaml (upstream.pinned)
ARG WHISPER_VERSION=20250625
# --no-deps, then the dependencies by hand, to drop exactly one of them: `triton`. Upstream asks
# for it on linux/x86_64 unconditionally, it is a ~250 MB GPU kernel compiler, and the only things
# that import it are whisper/triton_ops.py's two CUDA kernels, both reached through lazy
# function-local imports behind `if x.is_cuda` (whisper/timing.py:38 and :109). On a CPU machine
# that branch is never taken, so the package would be a quarter of the image for dead weight.
# The smoke test below is what keeps this honest: if a release ever imports triton at module
# scope, `whisper --help` stops working and this build goes red.
RUN pip install --no-cache-dir --no-deps "openai-whisper==${WHISPER_VERSION}" \
    && pip install --no-cache-dir more-itertools numba numpy tiktoken tqdm

# Models are baked into the image and seeded onto the volume by entrypoint.sh, NOT downloaded here
# into the cache directory: XDG_CACHE_HOME points at /data, the volume mounts over /data at
# runtime, and anything this build wrote there would be masked on the first boot.
#
# tiny (75 MB) and base (139 MB) only. They are the two that a default-sized machine can actually
# run, and having them present is what makes the first command someone types work offline and
# instantly instead of pulling 1.5 GB. Larger models download on demand into the volume.
# The SHA-256 of each is the second-to-last path segment of its own URL: that is upstream's own
# integrity scheme (whisper/__init__.py:_download re-derives and checks it), so these are not
# hashes invented here.
RUN set -eu; \
    mkdir -p /opt/whisper-models; \
    for spec in \
        "tiny.pt 65147644a518d12f04e32d6f3b26facc3f8dd46e5390956a9424a650c0ce22b9" \
        "base.pt ed3a0b6b1c0edf879ad9b11b1af5a0e6ab5db9205f891f668f8b0e6c6326e34e" \
    ; do \
        set -- $spec; \
        curl -fsSL "https://openaipublic.azureedge.net/main/whisper/models/$2/$1" \
            -o "/opt/whisper-models/$1"; \
        echo "$2  /opt/whisper-models/$1" | sha256sum -c -; \
    done

# Upstream's own test fixture: 11 seconds of the JFK inaugural address, public domain speech.
# It ships so that the box has something to transcribe before the user has solved getting their
# own audio in, and so the build-time smoke test below runs on real audio rather than silence.
ARG SAMPLE_SHA256=63a4b1e4c1dc655ac70961ffbf518acd249df237e5a0152faae9a4a836949715
RUN set -eu; \
    mkdir -p /opt/whisper-samples; \
    curl -fsSL "https://raw.githubusercontent.com/openai/whisper/v${WHISPER_VERSION}/tests/jfk.flac" \
        -o /opt/whisper-samples/jfk.flac; \
    echo "${SAMPLE_SHA256}  /opt/whisper-samples/jfk.flac" | sha256sum -c -

# A real transcription at build time, which is the only check that covers the whole chain at once:
# the torch wheel loads, numba compiles, ffmpeg decodes the file, the baked model deserialises and
# the CLI writes an output file. Any of those failing is otherwise a runtime surprise inside a
# terminal nobody is watching. The transcript is printed rather than pattern-matched: asserting on
# model output would make this build fail on a wording change in a 75 MB model, so the machine
# checks that real text came out and a human reads the text in the build log.
RUN set -eu; \
    whisper --help > /dev/null; \
    cd /tmp; \
    whisper /opt/whisper-samples/jfk.flac \
        --model tiny --model_dir /opt/whisper-models \
        --output_dir /tmp/smoke --output_format txt \
        --language en --fp16 False; \
    test -s /tmp/smoke/jfk.txt; \
    chars="$(tr -d '[:space:]' < /tmp/smoke/jfk.txt | wc -c)"; \
    test "$chars" -ge 40 || { echo "smoke transcript is $chars chars, expected real speech" >&2; exit 1; }; \
    echo "=== smoke transcript (tiny, $chars chars) ==="; \
    cat /tmp/smoke/jfk.txt; \
    echo "=== end smoke transcript ==="; \
    rm -rf /tmp/smoke

# Asserted so a dependency bump cannot quietly reintroduce the GPU compiler the step above dropped.
RUN ! pip show triton > /dev/null 2>&1 || { echo "triton got installed after all" >&2; exit 1; }

# Both on the volume: HOME so shell history, audio files and transcripts survive a restart, and
# XDG_CACHE_HOME because that is the variable whisper reads to place its model cache
# (whisper/__init__.py:134 resolves $XDG_CACHE_HOME/whisper), so a model downloaded once is not
# downloaded again on every boot. Checked, not assumed.
ENV HOME=/data/home
ENV XDG_CACHE_HOME=/data/cache

# Printed by a login shell, which is why entrypoint.sh runs `bash -l`. A browser terminal opens on
# a bare prompt with no page around it to explain itself, so the usage lives where the user lands.
COPY motd.sh /etc/profile.d/zz-whisper-motd.sh
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /etc/profile.d/zz-whisper-motd.sh

EXPOSE 7681
CMD ["/entrypoint.sh"]
