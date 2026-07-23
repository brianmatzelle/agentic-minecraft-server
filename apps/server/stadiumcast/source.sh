#!/bin/bash
# Flip the jumbotron source: /opt/source.sh live|bloomberg
# Writes /media/source and kills the current pipeline; the entrypoint loop
# re-reads the file and starts the new one within ~5s. State persists across
# container restarts — "live" (the garviscam camera) is the no-file default.
set -eu
MODE="${1:?usage: source.sh live|bloomberg}"
case "$MODE" in
  live|bloomberg) ;;
  *) echo "unknown mode: $MODE (live|bloomberg)" >&2; exit 1 ;;
esac
echo "$MODE" > /media/source
pkill -x ffmpeg 2>/dev/null || true
pkill -x sanjuuni 2>/dev/null || true
echo "source -> $MODE (pipeline restarting)"
