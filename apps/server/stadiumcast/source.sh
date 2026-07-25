#!/bin/bash
# Flip the jumbotron source:
#   /opt/source.sh live|bloomberg
#   /opt/source.sh youtube <url>
#   /opt/source.sh channel <id-or-name>     (iptv-org catalog — see channels.js)
# Writes /media/source and kills the current pipeline; the entrypoint loop
# re-reads the file and starts the new one within ~5s. State persists across
# container restarts — "live" (the garviscam camera) is the no-file default.
set -eu
# shellcheck source=ytdlp-args.sh
. /opt/ytdlp-args.sh

MODE="${1:?usage: source.sh live|bloomberg|youtube <url>|channel <id-or-name>}"
case "$MODE" in
  live|bloomberg)
    echo "$MODE" > /media/source
    : > /media/now-playing
    ;;
  channel)
    QUERY="${2:?usage: source.sh channel <id-or-name>}"
    # Resolve name/id -> catalog entry (exit 1 with its own message if unknown).
    if ! RES=$(node /opt/channels.js resolve "$QUERY" 2>&1); then
      echo "${RES:-no channel matching: $QUERY}" >&2; exit 1
    fi
    ID=${RES%%$'\t'*}
    LABEL=${RES#*$'\t'}
    # --probe IS the vet: it returns the best-ranked variant that actually plays,
    # and exits non-zero when none of them do — so a dead pick leaves whatever was
    # already on the faces alone. Same contract as the youtube mode.
    if ! URLLINE=$(node /opt/channels.js url "$ID" --probe 2>&1); then
      echo "$LABEL won't play right now: ${URLLINE:-dead or geo-blocked}" >&2
      exit 1
    fi
    printf '%s\n' "$LABEL" > /media/now-playing
    printf 'channel %s\n' "$ID" > /media/source
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
    echo "unknown mode: $MODE (live|bloomberg|youtube <url>|channel <id-or-name>)" >&2; exit 1 ;;
esac

pkill -x ffmpeg 2>/dev/null || true
pkill -x sanjuuni 2>/dev/null || true
# The "▶ <title>" shape is load-bearing: garvis-bot parses it back out to tell
# the player what came up (jumbotron.js titleFrom()).
case "$MODE" in
  youtube) echo "source -> youtube ▶ $TITLE (pipeline restarting)" ;;
  channel) echo "source -> channel ▶ $LABEL (pipeline restarting)" ;;
  *)       echo "source -> $MODE (pipeline restarting)" ;;
esac
