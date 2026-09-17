# Whisper

Speech recognition and translation in a browser terminal.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://console.instacloud.com/templates/whisper)

## Overview

This template runs [Whisper](https://github.com/openai/whisper), OpenAI's speech recognition model,
inside a container that exposes a browser terminal. You open a URL, authenticate, and get a `bash`
shell with the `whisper` CLI and `ffmpeg` already installed, plus two models already on disk. You
point it at an audio file and it writes a transcript.

Whisper is a command-line tool, not a web application: upstream ships one entry point,
`whisper.transcribe:cli`, and no server of any kind. So the long-running process here is
[ttyd](https://github.com/tsl0922/ttyd), which owns the port and gives the CLI an HTTPS face. The
`whisper` command finishing does not stop the service, the same arrangement the `claude-code`,
`codex`, `dsh` and `pi` templates use. What this template is not is a transcription API or an
upload form: it is the upstream CLI, reached from a browser.

The image is built from the Dockerfile in this directory: `python:3.11-slim-bookworm` (pinned by
digest), ttyd 1.7.7 (verified against a pinned SHA-256), CPU-only PyTorch, and `openai-whisper`
pinned to an exact version. The build runs a real transcription of upstream's own 11-second test
fixture before it publishes, so an image that cannot actually transcribe does not ship.

## What you get by hosting it

- An HTTPS URL for the terminal, with no port forwarding or tunnel to manage.
- **Two models already on disk.** `tiny` (75 MB) and `base` (139 MB) are baked into the image and
  seeded onto the volume at first boot, so the first command you type transcribes immediately
  instead of downloading a model first. Larger models download on demand.
- A persistent volume mounted at `/data`. `HOME` is `/data/home` and `XDG_CACHE_HOME` is
  `/data/cache`, which is the variable Whisper itself reads to place its model cache. So your
  audio, your transcripts, your shell history and any model you download survive restarts,
  redeploys and version upgrades. A model is downloaded once, not once per boot.
- `ffmpeg` installed, which Whisper shells out to for every input file. Without it the CLI fails on
  the first file it is given, so this is a prerequisite rather than an extra.
- A sample file at `/opt/whisper-samples/jfk.flac` to try before you have solved getting your own
  audio in.
- The terminal credentials kept as service variables rather than baked into the image, so you can
  change them later without rebuilding anything. They are yours, not ours: the template ships no
  credential of its own.
- Deploys are health-gated: a container that does not answer is rolled back to the last healthy
  image instead of leaving you with a dead URL.

## What you need before deploying

- A username and a password of your choosing for the terminal sign-in. There is no default: the
  deploy form starts with both fields empty and will not submit until you fill them.
- Audio or video files to transcribe, and a way to fetch them: a URL you can `curl`, or a
  repository you can `git clone`. See [Getting files in and out](#getting-files-in-and-out).
- Nothing else. There is no API key: the model runs on the machine, and nothing leaves it.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_USERNAME` | yes | HTTP basic-auth username for the terminal. You choose it; it may not contain a colon, which is the separator ttyd splits on. |
| `ADMIN_PASSWORD` | yes | HTTP basic-auth password for the terminal. You choose it. |

Both credentials are required and neither has a default, so the deploy form starts empty and refuses
to submit until you supply them. Together they must stay under 186 bytes (`username:password`):
past that, ttyd 1.7.7 starts normally and then answers 401 to everyone including you, so the
entrypoint stops the container instead of leaving you with an unreachable terminal.

Set by the template, not by you: `HOME=/data/home` and `XDG_CACHE_HOME=/data/cache`, which put your
files and the model cache on the volume.

**Pick the password like it guards a shell, because it does.** What it protects is a root shell that
can run anything, so whoever has the URL and this password has all of that. Both fields can be
changed later from the service's variables.

## After deploy

1. Open the service URL. The browser asks for HTTP basic auth: the `ADMIN_USERNAME` and
   `ADMIN_PASSWORD` you deployed with.
2. You land in a `bash` shell in `/data/home`, with a short usage banner.
3. Transcribe the sample file to confirm the box works:

   ```bash
   whisper /opt/whisper-samples/jfk.flac --model base --language en --output_dir transcripts
   cat transcripts/jfk.txt
   ```

4. Fetch your own audio and transcribe that:

   ```bash
   curl -L -o audio/talk.mp3 https://example.com/talk.mp3
   whisper audio/talk.mp3 --model base --output_dir transcripts
   ```

5. Translate instead of transcribing with `--task translate`, which writes English from any of the
   languages in the [model card](https://github.com/openai/whisper/blob/main/model-card.md).
6. `whisper --help` lists everything else: `--output_format` (`txt`, `srt`, `vtt`, `tsv`, `json`),
   `--language`, `--word_timestamps`, and the decoding options.

### Choosing a model

`--model base` is the default worth typing. The CLI's own default is `turbo`, which is a 1.5 GB
download and wants several GB of memory, so on a small machine it is the one command in this README
that can fail for reasons that are not your fault.

| Model | Size | On disk already |
|---|---|---|
| `tiny` | 75 MB | yes |
| `base` | 139 MB | yes |
| `small` | 484 MB | downloads on first use |
| `medium` | 1.5 GB | downloads on first use |
| `turbo`, `large` | 1.5 GB, 2.9 GB | downloads on first use |

Run `free -m` and `df -h /data` before reaching for a larger one. A model that does not fit in
memory is killed by the kernel mid-run, which looks like the command simply dying.

### Getting files in and out

A browser terminal cannot open a file picker on your laptop, so this is worth reading once:

- **In:** `curl -L -o audio/name.mp3 <url>` or `wget -P audio <url>` for anything reachable by URL,
  or `git clone` for anything in a repository. Both tools and `git` are installed.
- **Out:** `cat transcripts/name.txt` and copy from the terminal, which is fine for a transcript and
  tedious for a batch. For anything larger, push it somewhere from inside the box: `curl -T`, a
  `git push`, or an object-store CLI you install yourself with `pip install`.
- **Long files:** a transcription is a foreground command. This service is not `alwaysOn`, so a
  browser tab closed mid-run can let the machine idle out with the job unfinished. Use
  `nohup whisper ... > transcripts/run.log 2>&1 &` for anything long, then reconnect and read the
  log.

## Links

- Architecture: `linux/amd64`. See the [architectures table](../README.md#architectures) for why
  `arm64` is not declared: it is an unproven build rather than a known incompatibility.
- Upstream: <https://github.com/openai/whisper>
- Model card: <https://github.com/openai/whisper/blob/main/model-card.md>
- Package: [`openai-whisper`](https://pypi.org/project/openai-whisper/)
- ttyd: <https://github.com/tsl0922/ttyd>
- License: Whisper's code and model weights are MIT (upstream `LICENSE`). ttyd is MIT. The
  Dockerfile and manifest in this directory are part of this repository.
