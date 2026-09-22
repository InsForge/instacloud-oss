#!/bin/sh
set -e
# The key gets no fallback on purpose. The manifest declares it required with no default and no
# generator, so the platform always supplies it; a missing one means the image was started some
# other way, and inventing a value would publish an open inference endpoint whose cheapest
# request is a few hundred milliseconds of CPU.
#
# Checked here as well as in serve.py so the failure is one readable line in the deploy log rather
# than a Python KeyError traceback, and so it happens before uvicorn imports 1 GB of torch.
: "${API_KEY:?API_KEY is required}"

# One worker, and this is not a tuning choice. Each uvicorn worker imports serve.py in its own
# process and so loads its own copy of the checkpoint, which is 1.7 GB resident once torch upcasts
# the fp16 weights to fp32 on CPU. A second worker doubles that for no throughput: inference here
# is already CPU-bound across every core.
exec uvicorn serve:app --host 0.0.0.0 --port "${PORT:-8080}" --workers 1
