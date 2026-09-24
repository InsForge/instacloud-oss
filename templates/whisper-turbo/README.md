# whisper-turbo.c

CPU-only Whisper large-v3-turbo speech-to-text behind an OpenAI-compatible API.

> **Draft.** The image builds, the deploy is green and transcription has been verified end to end.
> It stays out of the catalog while four calls are open: the optional speaker-label path has never
> been run, because its weights are gated on Hugging Face and nobody has deployed this with a token
> that has accepted the conditions; this ships upstream's *experimental* INT8 activations on by
> default because the FP32 default cannot answer inside the edge's 60 second limit (see
> [Why INT8 is on by default](#why-int8-is-on-by-default)); `meta.category` is `llm`, which is wrong
> for a speech recognition model and there is no better category yet; and the server accepts only
> 16 kHz mono 16-bit WAV, so most people's audio needs converting first.

## Overview

[whisper-turbo.c](https://github.com/baryhuang/whisper-turbo.c) is a from-scratch C
implementation of OpenAI's Whisper large-v3-turbo. There is no Python, no PyTorch and no
whisper.cpp underneath it: the encoder, decoder, mel frontend and INT8 kernels are all C, with
AVX2/AVX-512/VNNI paths selected at runtime. It runs on CPU and needs no GPU.

It serves a documented subset of the OpenAI transcription API, so an existing OpenAI client can
be pointed at it by changing the base URL. It is an **API, not an app**: the server has exactly
two routes, `GET /health` and `POST /v1/audio/transcriptions`, and ships no web UI of any kind.
Nothing in this template adds one.

Upstream publishes no image, no release and no git tag, so `./Dockerfile` builds the server from
a pinned commit. It also converts the Whisper checkpoint to upstream's packed INT8 format at
build time and bakes the result into the image, which is the one real departure from upstream's
own `Dockerfile.cloud`. See [Why the model is in the image](#why-the-model-is-in-the-image).

## What you get by hosting it

- Transcription with automatic language detection, on your own machine, over HTTPS.
- Audio that never leaves your deployment. `whisper-1` and the other model aliases the API
  accepts all run against the local model; nothing is forwarded to OpenAI.
- A drop-in base URL for OpenAI transcription clients, authenticated with a bearer token you
  choose.
- No cold model download. The converted model is inside the image, so a restart or a
  redeployment comes back with no network fetch and no warm-up step.
- Optional timestamped speaker labels, once you supply a Hugging Face token for upstream's gated
  diarization weights. See [Speaker labels](#speaker-labels).

## What you need before deploying

- A bearer token of your own choosing for `WHISPER_API_KEY`. Keep a copy before you submit the
  form: template variables are stored write-only and this one cannot be read back afterwards.
- Audio as **mono 16-bit PCM WAV at 16 kHz**, up to 300 seconds per request. The server does no
  format conversion and rejects anything else, so an MP3 or a 44.1 kHz stereo WAV has to be
  converted first, for example with
  `ffmpeg -i input.mp3 -ar 16000 -ac 1 -c:a pcm_s16le output.wav`.
- An amd64 box. The server compiles against x86 kernels and there is no arm64 image.
- Only for speaker labels: a Hugging Face account that has accepted the conditions on
  [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1),
  and an access token from it.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `WHISPER_API_KEY` | yes | The bearer token every request must carry. You choose the value; there is no default and nothing is generated for you, because you need to be able to send it back. Upstream refuses to start on a non-loopback bind without it |
| `OMP_NUM_THREADS` | fixed, `8` | Inference threads. Matches the 8 shared vCPUs a compute machine is configured with; the server clamps it to 1 to 8 |
| `WHISPER_ACTIVATIONS` | fixed, `int8` | INT8 encoder activations. See [Why INT8 is on by default](#why-int8-is-on-by-default); clearing it makes transcription time out |
| `WHISPER_DECODER_ACTIVATIONS` | fixed, `int8` | INT8 decoder projections and vocabulary head. Same reason, same section |
| `HF_TOKEN` | no | A Hugging Face access token, for speaker labels only. See [Speaker labels](#speaker-labels). Blank means transcription only |
| `WHISPER_DIAR_SIMD` | no | `avx512` selects the FP32 AVX-512 diarization kernels where the CPU has them, with fallback. No effect without `HF_TOKEN` |
| `WHISPER_DIAR_BATCH_INPUT` | no | `1` batches the diarizer's LSTM input projections. No effect without `HF_TOKEN` |
| `WHISPER_SIMD` | no | Pin the kernel path to `scalar`, `avx2` or `avx512`. Detected automatically when blank |
| `WHISPER_REQUEST_TIMEOUT` | no | Seconds allowed for one transcription before the server gives up. Default 300, maximum 3600. The edge cuts the connection at 60 seconds regardless |

A persistent volume is mounted at `/data`, and the only thing that ever lands on it is the
diarization checkpoints below. Transcription itself keeps no state.

## After deploy

Check the service is up. `/health` is the one route that answers before the token check:

```sh
curl https://<your-service-url>/health
# {"status":"ready"}
```

Then transcribe. Everything else requires the bearer token:

```sh
curl https://<your-service-url>/v1/audio/transcriptions \
  -H "Authorization: Bearer $WHISPER_API_KEY" \
  -F file=@speech.wav -F model=whisper-1
# {"text":"..."}
```

Add `-F response_format=text` for a bare transcript instead of JSON, or `-F language=en` to skip
language detection. The server holds **one transcription at a time** and answers a second
concurrent request with `429`; queue on the client side if you need throughput.

Expect the first request after a start to be slower than later ones. The model is mmapped, so
the server is listening immediately but the 808 MiB of weights page in from disk during that
first transcription. Measured with the 11 second JFK sample: 15 seconds on the first request
after a restart, 9.5 seconds warm.

There are **no CORS headers**. A cross-origin preflight is answered `401` with no
`Access-Control-Allow-Origin`, so browser JavaScript cannot call this API directly. Call it from
your own backend, or put a proxy in front of it.

## Speaker labels

Upstream ships a C port of the pyannote Community-1 diarization pipeline, which labels who spoke
when. Its four checkpoints are gated on Hugging Face (CC BY 4.0, with access conditions accepted
per account), so they are **not** in this image and CI cannot fetch them either.

To turn it on: accept the conditions on
[pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1),
create an access token, and set it as `HF_TOKEN`. On the next start the entrypoint downloads the
four files (33 MB), checks each one's SHA-256 against upstream's published values, and leaves them
on the volume, so later restarts find them already there.

```sh
curl https://<your-service-url>/v1/audio/transcriptions \
  -H "Authorization: Bearer $WHISPER_API_KEY" \
  -F file=@conversation.wav -F model=gpt-4o-transcribe-diarize \
  -F response_format=diarized_json -F chunking_strategy=auto
```

The response carries `text`, timestamped `segments` each with a `speaker` label (`A`, `B`, ...),
and duration `usage`. Labels distinguish voices, not people, and overlapping speech is not
separated.

A token that does not work is not fatal. The failure is logged, the service still starts, and
diarized requests keep answering `503` with `Configure WHISPER_DIARIZATION_MODELS to enable
diarization.` while transcription carries on unaffected. That is deliberate: making a bad token
fatal would produce a restart loop that never reaches the health gate and reads as a broken
template. The same 60 second edge limit applies, and diarization is slower than transcription
alone, so keep diarized clips short.

## Why INT8 is on by default

`WHISPER_ACTIVATIONS` and `WHISPER_DECODER_ACTIVATIONS` are `int8` in the manifest, and that is
not a tuning preference. The edge in front of a compute service cuts a request off at 60 seconds,
and upstream's documented-safe FP32-activation default does not finish an 11 second clip inside
that. Measured on this platform, same machine, same audio:

| Activations | Result |
|---|---|
| FP32 (upstream default) | more than 118 seconds, never returned, edge `502` at 60 seconds |
| INT8 (what this ships) | 15.2 seconds cold, 9.5 seconds warm, `200` with the correct transcript |

Upstream marks INT8 activations experimental and documents accuracy limitations, and its own
published benchmarks are measured with both of them enabled. The machines this lands on carry
AVX-512 VNNI, which is the kernel path that produces the difference. If you would rather have
FP32 and drive the API from a client that tolerates a long request, clear both variables on the
service after deploy; be aware that the public URL will then time out.

## Why the model is in the image

Upstream's `Dockerfile.cloud` downloads the 1.6 GB GGML checkpoint and converts it on first
boot into a mounted volume, deliberately, to keep the image small and the build fast. That shape
does not survive this platform's deploy gate: the entrypoint does all of that work *before* it
execs the server, so nothing is listening on the port for minutes, and the gate sends a real HTTP
request and fails long before the port opens. There is no manifest field that extends it.

So `./Dockerfile` does the download, the SHA-256 check and the conversion in the build stage and
copies the 808 MiB result into the final image. The trade is a large image and a slow CI build,
against a deploy that passes its health check on the first try and is byte-identical after every
restart. The volume this template does mount carries only the optional diarization checkpoints;
the Whisper model never touches it.

## Links

- Upstream: <https://github.com/baryhuang/whisper-turbo.c>, pinned at commit
  `54ad979a08e654929186b374d266a4ced291f1be` (upstream publishes no tags or releases)
- API reference: <https://github.com/baryhuang/whisper-turbo.c/blob/main/docs/http-api.md>
- Image: `ghcr.io/insforge/insta-oss/templates/whisper-turbo`, built from `./Dockerfile`
- Model checkpoint: `ggml-large-v3-turbo.bin` from
  <https://huggingface.co/ggerganov/whisper.cpp>, pinned by SHA-256 in the Dockerfile
- Diarization weights: <https://huggingface.co/pyannote/speaker-diarization-community-1>, CC BY 4.0
  with access conditions. Not distributed in this image; fetched at boot from your own token
- License: MIT (upstream `baryhuang/whisper-turbo.c`). The Whisper weights are OpenAI's, under
  MIT. `src/diarization/network.c` and `src/diarization/cluster.c` are Apache-2.0; see upstream's
  `THIRD_PARTY_DIARIZATION.md`
