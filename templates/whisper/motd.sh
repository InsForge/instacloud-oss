# Sourced by /etc/profile for every login shell the browser terminal opens.
# Guarded so it prints once per terminal and stays out of the way of scripts and subshells.
case "$-" in *i*) ;; *) return 0 ;; esac

cat <<'BANNER'

  Whisper: OpenAI's speech recognition CLI. Transcribe or translate audio.

    whisper audio/talk.mp3 --model base --output_dir transcripts
    whisper audio/talk.mp3 --model base --language en --task translate

  Models     tiny and base are already on disk. small, medium, turbo and large
             download on first use (turbo is 1.5 GB) and need more memory than
             a small machine has: check `free -m` before reaching for them.
  Persists   everything under /data: audio/, transcripts/ and the model cache.
             Anything written elsewhere is lost when the container restarts.
  Get files  in with `curl -O <url>` or `wget <url>` into ~/audio
             out by reading the transcript here, e.g. `cat transcripts/talk.txt`
  Sample     /opt/whisper-samples/jfk.flac, 11 seconds, for a first run

BANNER
