#!/bin/sh
set -e
# The key gets no fallback on purpose. The manifest declares it required with no default and no
# generator, so the platform always supplies it; a missing one means the image was started some
# other way, and inventing a value would publish an open inference endpoint whose every request is
# a forward pass through a 4B model.
#
# Checked here as well as in serve.py so the failure is one readable line in the deploy log rather
# than a Python KeyError traceback, and so it happens before uvicorn imports torch.
: "${API_KEY:?API_KEY is required}"

# The Hub cache lives on the volume, so the 9.3 GB backbone is fetched once per deployment instead
# of once per restart. Created here rather than left to huggingface_hub because the volume is
# mounted empty and a first-boot failure to write it is much easier to read as one line here.
mkdir -p "${HF_HOME:-/data/hf}"

# One worker, and this is not a tuning choice: each uvicorn worker imports serve.py in its own
# process and so maps its own copy of the backbone. A second worker would double a footprint that
# already exceeds the machine's memory ceiling, for no throughput, since a forward pass here is
# CPU-bound across every core already.
exec uvicorn serve:app --host 0.0.0.0 --port "${PORT:-8080}" --workers 1
