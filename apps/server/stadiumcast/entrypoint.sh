#!/bin/bash
# Keep the live encoder up. The jumbotron source is switchable (/media/source,
# default "live"; flip with /opt/source.sh — kills the pipeline, this loop
# re-reads the file and starts the new one):
#   live            — sanjuuni listens on :8180 for the garviscam mpegts push
#   bloomberg       — in-container ffmpeg pulls Bloomberg TV's public HLS feed
#   youtube <url>   — yt-dlp resolves the link, ffmpeg pulls it (see YT_FPS below)
# Both pulled modes downsample to 542x414 (same codec recipe as camloop's push)
# and push mpegts to sanjuuni on 127.0.0.1:8181; garviscam's :8180 push just gets
# connection-refused meanwhile — camloop already retries forever.
# sanjuuni exits when its input stream ends (camera restart, HLS drop) — loop it.
set -u
# shellcheck source=ytdlp-args.sh
. /opt/ytdlp-args.sh

W="${CAST_W:-542}"
H="${CAST_H:-414}"
# Bloomberg's own manifest (via iptv-org's streams.json, same source the termtv
# app uses). If it ever dies, re-resolve: jq '.[] | select(.channel ==
# "BloombergTV.us") | .url' streams.json — or override via compose env.
BLOOMBERG_URL="${BLOOMBERG_URL:-https://bloomberg.com/media-manifest/streams/us.m3u8}"
# The faces really draw 3-4fps (5 monitors x 164x81 blit per frame, server-tick
# bound). A live feed self-corrects when the encoder outruns that — the HLS demuxer
# just skips to the live edge — but a VOD has no live edge: encode faster than it
# draws and TCP backpressure stalls ffmpeg, i.e. slow motion (measured 0.8x at 4fps).
# So encode just UNDER the draw ceiling and let ffmpeg's -re be the clock: 3fps in,
# ~3.2fps of drawing capacity, playback lands at real time.
YT_FPS="${YT_FPS:-3}"
# Prefer an already-muxed (or video-only) ≤720p format: no merge needed, and the
# faces are 542x414 anyway. Audio is dropped regardless — the monitors are silent.
YT_FORMAT="${YT_FORMAT:-b[height<=720]/bv*[height<=720]/b/bv*}"

# Print a direct media URL for a yt-dlp-supported link, or nothing. yt-dlp goes
# stale fast against YouTube's anti-bot, so a first failure triggers a self-update
# (the standalone binary updates itself in place) and one retry.
resolve_yt() {
  local url="$1" out
  out=$(timeout 120 yt-dlp $(yt_args) -f "$YT_FORMAT" -g --no-warnings --no-playlist "$url" 2>>/media/youtube.log | head -1)
  if [ -z "$out" ]; then
    echo "[yt] resolve failed — self-updating yt-dlp, then retrying once" >> /media/youtube.log
    timeout 300 yt-dlp --update-to nightly >> /media/youtube.log 2>&1
    out=$(timeout 120 yt-dlp $(yt_args) -f "$YT_FORMAT" -g --no-warnings --no-playlist "$url" 2>>/media/youtube.log | head -1)
  fi
  printf '%s' "$out"
}

# ffmpeg leg shared by the pulled modes: <input-url> <fps> <logfile> [extra-input-args...]
# The hop is a FIFO, not a socket, on purpose: when a pulled pipeline ends the pair
# gets torn down and restarted seconds later, and a TCP hop can't rebind — the just-
# closed connection sits in TIME_WAIT on the same local port for ~60s, so sanjuuni
# died on bind and ffmpeg logged "Connection refused" for a minute (VOD end made this
# fire every loop). A FIFO has no port to conflict over, needs no bind-before-dial
# sleep, and gives the same read-on-demand backpressure.
CAST_FIFO=/tmp/cast.ts
pull_to_sanjuuni() {
  local input="$1" fps="$2" log="$3"; shift 3
  [ -p "$CAST_FIFO" ] || { rm -f "$CAST_FIFO"; mkfifo "$CAST_FIFO"; }
  sanjuuni -f mpegts -i "$CAST_FIFO" \
    -W "$W" -H "$H" -w 8177 -T --disable-opencl >> /media/live.log 2>&1 &
  local sanjuuni_pid=$!
  ffmpeg -hide_banner -loglevel warning -y \
    -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
    "$@" -i "$input" -map 0:v:0 -an -sn -dn \
    -vf "fps=${fps},scale=${W}:${H}" \
    -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p \
    -f mpegts "$CAST_FIFO" >> "$log" 2>&1
  kill "$sanjuuni_pid" 2>/dev/null
  wait "$sanjuuni_pid" 2>/dev/null
}

if [ "${CAST_AUTOSTART:-0}" = "1" ]; then
  (
    while true; do
      LINE=$(head -1 /media/source 2>/dev/null || echo live)
      SRC=${LINE%% *}
      ARG=${LINE#* }; [ "$ARG" = "$LINE" ] && ARG=""
      case "$SRC" in
        bloomberg)
          pull_to_sanjuuni "$BLOOMBERG_URL" 10 /media/bloomberg.log
          ;;
        youtube)
          STREAM=$(resolve_yt "$ARG")
          if [ -z "$STREAM" ]; then
            echo "[cast] yt-dlp could not resolve $ARG — retrying in 30s (see /media/youtube.log)" >> /media/live.log
            sleep 30
            continue
          fi
          # -re paces a file at 1x; -stream_loop -1 repeats it in-process, so a short
          # video loops without tearing the pipeline down every time it ends. ffmpeg
          # only exits for real on error or when the ~6h googlevideo URL expires —
          # then the outer loop re-resolves and picks up a fresh one.
          pull_to_sanjuuni "$STREAM" "$YT_FPS" /media/youtube.log -re -stream_loop -1
          ;;
        *)
          sanjuuni -f mpegts -i "tcp://0.0.0.0:8180?listen" \
            -W "$W" -H "$H" -w 8177 -T --disable-opencl >> /media/live.log 2>&1
          ;;
      esac
      echo "[cast] pipeline ($SRC) exited, restarting in 3s" >> /media/live.log
      sleep 3
    done
  ) &
fi
exec tail -f /dev/null
