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
CAST_WS_PORT="${CAST_WS_PORT:-8177}"

# --- Leak guard (2026-07-24 outage) -----------------------------------------
# sanjuuni's -T "streamed" mode only frees a frame once it has actually been
# SENT to a websocket client (sanjuuni.cpp: `if (streamed) frameStorage[frame]
# = ""`). With nobody attached nothing is ever freed, so an endless source grows
# frameStorage without bound: 28h of Bloomberg at 10fps with zero viewers hit
# 94GB RSS, filled RAM + all 16GB of swap, and thrashed the host hard enough
# that the Minecraft JVM fell 163 ticks behind and got cycled three times.
#
# The obvious fix — don't start the feed until a viewer connects — can't work as
# stated: sanjuuni opens its INPUT (sanjuuni.cpp:657) long before it binds the
# websocket port (:981), and opening the FIFO blocks until ffmpeg writes to it.
# A "parked" sanjuuni therefore never listens, so nothing could ever connect to
# open the gate. Instead we duty-cycle: bring the pair up for PROBE_WINDOW
# seconds to offer a connection, and if nobody attaches, tear it down and park
# for PARK_SECS. jumboplay already reconnects every 3s on its own (jumboplay.lua
# :51-55), so it latches onto the next window with no help from us. Once a
# viewer IS attached the feed runs continuously and memory stays flat.
CAST_PROBE_WINDOW="${CAST_PROBE_WINDOW:-30}"   # how long to offer a connection
CAST_PARK_SECS="${CAST_PARK_SECS:-45}"         # how long to stay down when unwatched
CAST_IDLE_GRACE="${CAST_IDLE_GRACE:-30}"       # grace after the last viewer leaves
CAST_MAX_RSS_MB="${CAST_MAX_RSS_MB:-1024}"     # recycle if it grows anyway

# Established websocket connections to sanjuuni. /proc/net/tcp needs no extra
# package (the image has no iproute2) and is network-namespaced to this
# container, so it only ever sees jumboplay's own connections. Field 2 is
# "localaddr:porthex", field 4 is the TCP state (01 = ESTABLISHED).
ws_clients() {
  awk -v p="$(printf '%04X' "$CAST_WS_PORT")" \
    'substr($2, index($2, ":") + 1) == p && $4 == "01"' \
    /proc/net/tcp /proc/net/tcp6 2>/dev/null | wc -l
}

rss_mb() { awk '/^VmRSS:/ {print int($2 / 1024); exit}' "/proc/$1/status" 2>/dev/null; }

cast_log() { echo "[cast] $*" >> /media/live.log; }

# Watch a running pair and return once it should come down: the feeder died, the
# frame store hit the cap, or nobody is watching. Prints "park" when the caller
# should idle before rebuilding (vs. an ordinary stream-ended restart).
supervise() {
  local sj="$1" feeder="${2:-}" waited=0 idle=0 seen=0 rss
  while kill -0 "$sj" 2>/dev/null; do
    if [ -n "$feeder" ] && ! kill -0 "$feeder" 2>/dev/null; then return 0; fi
    sleep 2
    rss=$(rss_mb "$sj")
    if [ "${rss:-0}" -ge "$CAST_MAX_RSS_MB" ]; then
      cast_log "frame store at ${rss}MB — recycling pipeline"
      return 0
    fi
    if [ "$(ws_clients)" -gt 0 ]; then
      seen=1; idle=0
    elif [ "$seen" -eq 1 ]; then
      idle=$((idle + 2))
      if [ "$idle" -ge "$CAST_IDLE_GRACE" ]; then
        cast_log "viewer left — parking the feed"; echo park; return 0
      fi
    else
      waited=$((waited + 2))
      if [ "$waited" -ge "$CAST_PROBE_WINDOW" ]; then
        cast_log "no viewer after ${waited}s — parking the feed"; echo park; return 0
      fi
    fi
  done
  return 0
}

pull_to_sanjuuni() {
  local input="$1" fps="$2" log="$3"; shift 3
  [ -p "$CAST_FIFO" ] || { rm -f "$CAST_FIFO"; mkfifo "$CAST_FIFO"; }
  sanjuuni -f mpegts -i "$CAST_FIFO" \
    -W "$W" -H "$H" -w "$CAST_WS_PORT" -T --disable-opencl >> /media/live.log 2>&1 &
  local sanjuuni_pid=$!
  ffmpeg -hide_banner -loglevel warning -y \
    -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
    "$@" -i "$input" -map 0:v:0 -an -sn -dn \
    -vf "fps=${fps},scale=${W}:${H}" \
    -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p \
    -f mpegts "$CAST_FIFO" >> "$log" 2>&1 &
  local ffmpeg_pid=$!
  CAST_PARK=$(supervise "$sanjuuni_pid" "$ffmpeg_pid")
  kill "$ffmpeg_pid" "$sanjuuni_pid" 2>/dev/null
  wait "$ffmpeg_pid" "$sanjuuni_pid" 2>/dev/null
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
          # Same guard as the pulled modes: garviscam's push is endless too, so
          # an unwatched live feed leaks in exactly the same way.
          sanjuuni -f mpegts -i "tcp://0.0.0.0:8180?listen" \
            -W "$W" -H "$H" -w "$CAST_WS_PORT" -T --disable-opencl >> /media/live.log 2>&1 &
          sanjuuni_pid=$!
          CAST_PARK=$(supervise "$sanjuuni_pid")
          kill "$sanjuuni_pid" 2>/dev/null
          wait "$sanjuuni_pid" 2>/dev/null
          ;;
      esac
      if [ "${CAST_PARK:-}" = "park" ]; then
        sleep "$CAST_PARK_SECS"
      else
        cast_log "pipeline ($SRC) exited, restarting in 3s"
        sleep 3
      fi
      CAST_PARK=
    done
  ) &
fi
exec tail -f /dev/null
