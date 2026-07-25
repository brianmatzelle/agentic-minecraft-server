#!/bin/bash
# Flip the jumbotron source: /opt/source.sh live|bloomberg|youtube <url>
# Writes /media/source and kills the current pipeline; the entrypoint loop
# re-reads the file and starts the new one within ~5s. State persists across
# container restarts — "live" (the garviscam camera) is the no-file default.
set -eu
# shellcheck source=ytdlp-args.sh
. /opt/ytdlp-args.sh

MODE="${1:?usage: source.sh live|bloomberg|youtube <url>}"
case "$MODE" in
  live|bloomberg)
    echo "$MODE" > /media/source
    : > /media/now-playing
    ;;
  youtube)
    URL="${2:?usage: source.sh youtube <url>}"
    case "$URL" in http://*|https://*) ;; *) echo "not an http(s) url: $URL" >&2; exit 1 ;; esac
    # Resolve BEFORE flipping: a dead/blocked link should fail loudly (the caller
    # can tell the player) instead of blanking a screen that was happily playing.
    ERR=$(mktemp)
    TITLE=$(timeout 90 yt-dlp $(yt_args) --no-warnings --no-playlist \
              --print "%(title)s" "$URL" 2>"$ERR" | head -1) || true
    if [ -z "$TITLE" ]; then
      echo "yt-dlp couldn't play that link:" >&2
      tail -3 "$ERR" >&2
      rm -f "$ERR"
      exit 1
    fi
    rm -f "$ERR"
    printf '%s\n' "$TITLE" > /media/now-playing
    printf 'youtube %s\n' "$URL" > /media/source
    ;;
  *)
    echo "unknown mode: $MODE (live|bloomberg|youtube <url>)" >&2; exit 1 ;;
esac

pkill -x ffmpeg 2>/dev/null || true
pkill -x sanjuuni 2>/dev/null || true
if [ "$MODE" = youtube ]; then
  echo "source -> youtube ▶ $TITLE (pipeline restarting)"
else
  echo "source -> $MODE (pipeline restarting)"
fi
