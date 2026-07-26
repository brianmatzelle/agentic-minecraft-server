#!/bin/bash
# Keep the live encoder up. The jumbotron source is switchable (/media/source,
# default "live"; flip with /opt/source.sh — kills the pipeline, this loop
# re-reads the file and starts the new one):
#
# TWO SCREENS (2026-07-25): the same loop runs twice, as two independent "legs"
# with different resolution/port/fifo — the 5-face stadium jumbotron (542x414 on
# :8177) and termtv, a small in-world TV set (158x114 on :8182, one monitor +
# speaker on one computer). One channel for the world (both legs read
# /media/source), but each leg resolves, pulls, encodes and parks on its own, so
# a viewer at one screen can never stall the other. See cast_loop().
#   live            — sanjuuni listens on :8180 for the garviscam mpegts push
#   bloomberg       — in-container ffmpeg pulls Bloomberg TV's public HLS feed
#   youtube <url>   — yt-dlp resolves the link, ffmpeg pulls it (see YT_FPS below)
#   channel <id>    — any iptv-org channel; channels.js owns the catalog and
#                     re-resolves the URL on every loop (they rotate), and also
#                     serves the control API the in-game picker tunes through
# Both pulled modes downsample to 542x414 (same codec recipe as camloop's push)
# and push mpegts to sanjuuni on 127.0.0.1:8181; garviscam's :8180 push just gets
# connection-refused meanwhile — camloop already retries forever.
# sanjuuni exits when its input stream ends (camera restart, HLS drop) — loop it.
#
# AUDIO (2026-07-25): the pulled modes also publish their chosen input to
# /media/audio-source, and castaudio.js turns it into a DFPWM websocket on :8179
# for the stadium speakers (see its header for why that is a second ffmpeg and
# not sanjuuni's own audio support). The video leg below is unchanged — it still
# strips audio, because THIS pipeline is paced by the faces' blit rate and audio
# has to be paced by wall-clock.
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
# Catalog channels are live HLS like Bloomberg, so the same 10fps applies: when
# the encoder outruns the faces the demuxer just skips to the live edge. Only
# VODs need the under-the-ceiling treatment above.
CHANNEL_FPS="${CHANNEL_FPS:-10}"
# Prefer an already-muxed ≤720p format: no merge needed, and the faces are
# 542x414 anyway. Muxed ("b") comes first partly so the audio leg has a stream to
# read — the video-only fallbacks still work, they just play silent.
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
# What the audio leg should pull, as "url \t user-agent \t referer \t flags".
# Written by pull_to_sanjuuni and truncated on teardown, so castaudio.js follows
# the pipeline automatically — including the leak guard's park cycles. Tabs, not
# spaces: user agents contain spaces. The referer stays a bare value; castaudio.js
# builds the CRLF header, since a literal one would break this file's line format.
AUDIO_SRC_FILE="${CAST_AUDIO_SRC:-/media/audio-source}"
# --- per-leg config (defaults = the jumbotron; the termtv leg overrides these in
# its own subshell at the bottom, so the two never share state) ---------------
LEG=jumbo
LEG_LOG=/media/live.log     # sanjuuni + supervisor chatter for this leg
FORCE_LOG=""                # non-empty: send every mode's ffmpeg log here too
# Where the camera feed comes from. Empty = bind :8180 and wait for garviscam's
# mpegts push (only one process can hold that listener, so only one leg may).
CAM_SRC=""

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

cast_log() { echo "[$LEG] $*" >> "$LEG_LOG"; }

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
  local input="$1" fps="$2" log="${FORCE_LOG:-$3}"; shift 3
  [ -p "$CAST_FIFO" ] || { rm -f "$CAST_FIFO"; mkfifo "$CAST_FIFO"; }
  # Hand the audio leg the same input we are about to play. It has to be OUR
  # resolved url, not a fresh resolve: channels.js ranks several variants per
  # channel and they are not always the same programme (asia vs eu manifests).
  # The 5th field picks the overflow policy: a live feed drops old audio to stay
  # near the edge, a VOD backpressures instead (see castaudio.js).
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$input" "${AUDIO_UA:-}" "${AUDIO_REF:-}" "${AUDIO_FLAGS:-}" "${AUDIO_KIND:-live}" \
    > "$AUDIO_SRC_FILE"
  sanjuuni -f mpegts -i "$CAST_FIFO" \
    -W "$W" -H "$H" -w "$CAST_WS_PORT" -T --disable-opencl >> "$LEG_LOG" 2>&1 &
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
  : > "$AUDIO_SRC_FILE"   # video is down — stop pulling audio too
}

# One screen's worth of pipeline, forever: read the tuned source, build the
# ffmpeg+sanjuuni pair for it, hand it to the leak guard, rebuild when it comes
# down. Every knob it uses (W/H, CAST_WS_PORT, CAST_FIFO, AUDIO_SRC_FILE, the fps
# caps, CAM_SRC, LEG*) is a plain variable, so a second screen is just a subshell
# that overrides them and calls this again.
cast_loop() {
  # Clear the audio hand-off before we start publishing into it — a stale line
  # from the previous container would otherwise have the audio leg pulling a dead
  # url until the first teardown.
  : > "$AUDIO_SRC_FILE" 2>/dev/null || true
  while true; do
      LINE=$(head -1 /media/source 2>/dev/null || echo live)
      SRC=${LINE%% *}
      ARG=${LINE#* }; [ "$ARG" = "$LINE" ] && ARG=""
      # Reset every loop so a previous mode's headers can't leak into this one.
      AUDIO_UA=""; AUDIO_REF=""; AUDIO_FLAGS=""; AUDIO_KIND="live"
      case "$SRC" in
        bloomberg)
          pull_to_sanjuuni "$BLOOMBERG_URL" 10 /media/bloomberg.log
          ;;
        channel)
          # Re-resolved (and re-probed) every loop on purpose: catalog URLs rotate,
          # and --probe picks the best-ranked variant that is playable RIGHT NOW, so
          # a variant dying mid-play heals into the next-best one instead of looping
          # on a corpse. Some CDNs 403 without the stream's own user_agent/referrer,
          # so carry those into ffmpeg as input options.
          if ! URLLINE=$(node /opt/channels.js url "$ARG" --probe 2>>/media/channels.log); then
            cast_log "no playable stream for channel '$ARG' — retrying in 30s (see /media/channels.log)"
            sleep 30
            continue
          fi
          IFS=$'\t' read -r CH_URL CH_UA CH_REF <<EOF
$URLLINE
EOF
          CH_ARGS=()
          if [ -n "${CH_UA:-}" ]; then CH_ARGS+=(-user_agent "$CH_UA"); fi
          if [ -n "${CH_REF:-}" ]; then CH_ARGS+=(-headers "$(printf 'Referer: %s\r\n' "$CH_REF")"); fi
          AUDIO_UA="${CH_UA:-}"; AUDIO_REF="${CH_REF:-}"
          pull_to_sanjuuni "$CH_URL" "$CHANNEL_FPS" /media/channel.log "${CH_ARGS[@]}"
          ;;
        youtube)
          STREAM=$(resolve_yt "$ARG")
          if [ -z "$STREAM" ]; then
            cast_log "yt-dlp could not resolve $ARG — retrying in 30s (see /media/youtube.log)"
            sleep 30
            continue
          fi
          # -re paces a file at 1x; -stream_loop -1 repeats it in-process, so a short
          # video loops without tearing the pipeline down every time it ends. ffmpeg
          # only exits for real on error or when the ~6h googlevideo URL expires —
          # then the outer loop re-resolves and picks up a fresh one.
          # The audio leg gets the same pacing flags: both legs -re at 1x, started
          # within a second of each other, so they stay roughly aligned. Two
          # independent processes on a VOD will drift eventually — that's the one
          # mode where audio sync is best-effort.
          AUDIO_FLAGS="-re -stream_loop -1"; AUDIO_KIND="vod"
          pull_to_sanjuuni "$STREAM" "$YT_FPS" /media/youtube.log -re -stream_loop -1
          ;;
        *)
          if [ -n "$CAM_SRC" ]; then
            # A second screen can't share garviscam's push (one TCP listener, one
            # process), so it takes the camera the long way round: Owncast is
            # already restreaming the very same client view as HLS, WITH game
            # audio. Costs ~10s of extra latency, and it only works while the web
            # stream is actually live — when it isn't, Owncast serves its
            # "stream offline" slate and that is what the TV shows.
            pull_to_sanjuuni "$CAM_SRC" "$CHANNEL_FPS" /media/camera.log
          else
            # No audio path for the camera feed here: garviscam's :8180 push is
            # video only (its game audio goes to Owncast), so keep the leg idle.
            : > "$AUDIO_SRC_FILE"
            # Same guard as the pulled modes: garviscam's push is endless too, so
            # an unwatched live feed leaks in exactly the same way.
            sanjuuni -f mpegts -i "tcp://0.0.0.0:8180?listen" \
              -W "$W" -H "$H" -w "$CAST_WS_PORT" -T --disable-opencl >> "$LEG_LOG" 2>&1 &
            sanjuuni_pid=$!
            CAST_PARK=$(supervise "$sanjuuni_pid")
            kill "$sanjuuni_pid" 2>/dev/null
            wait "$sanjuuni_pid" 2>/dev/null
          fi
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
}

# The jumbotron: 5 faces, 542x414, garviscam's push for camera mode.
if [ "${CAST_AUTOSTART:-0}" = "1" ]; then
  ( cast_loop ) &
fi

# termtv: a small in-world TV set — one monitor (79x38 chars at textScale 0.5)
# plus a speaker on one computer, running termtv.lua. Its own resolve, ffmpeg,
# sanjuuni and park cycle; nothing here can stall the jumbotron. Frames are ~8%
# of the jumbotron's pixel count, so a much lower RSS cap still holds thousands
# of them (both legs live under one 2g container limit), and it can afford to
# park in shorter cycles — the set lights up faster when you sit down at it.
# TERMTV_W/H must match the monitor: cols*2 x rows*3 at the scale termtv.lua sets,
# rounded to even (libx264 needs even dimensions), or the picture gets cropped.
if [ "${TERMTV:-1}" = "1" ]; then
  (
    LEG=termtv
    LEG_LOG=/media/termtv.log
    FORCE_LOG=/media/termtv.log
    W="${TERMTV_W:-158}"
    H="${TERMTV_H:-114}"
    CAST_WS_PORT="${TERMTV_WS_PORT:-8182}"
    CAST_FIFO=/tmp/termtv.ts
    AUDIO_SRC_FILE="${TERMTV_AUDIO_SRC:-/media/termtv-source}"
    # A 3002-char blit lands well inside one tick, so this screen is nowhere near
    # the faces' 3-4fps ceiling — it can take the full live rate.
    CHANNEL_FPS="${TERMTV_FPS:-10}"
    YT_FPS="${TERMTV_FPS:-10}"
    CAM_SRC="${TERMTV_LIVE_URL:-http://owncast:8080/hls/0/stream.m3u8}"
    CAST_MAX_RSS_MB="${TERMTV_MAX_RSS_MB:-256}"
    CAST_PROBE_WINDOW="${TERMTV_PROBE_WINDOW:-20}"
    CAST_PARK_SECS="${TERMTV_PARK_SECS:-20}"
    cast_loop
  ) &
fi

# Channel catalog + control API (:8178, internal compose network only — nothing
# published). This is what the in-game picker in jumboplay.lua talks to: it
# serves the curated grid + search over the ~8.5k-channel iptv-org catalog and
# shells back into source.sh to tune. It builds/refreshes the index on demand in
# a short-lived child process, so the 11MB catalog parse never lives in a
# long-running RSS next to sanjuuni's frame store.
if [ "${CAST_CTL:-1}" = "1" ]; then
  node /opt/channels.js serve >> /media/channels.log 2>&1 &
fi

# TV audio (:8179, internal only). Follows /media/audio-source and serves 1-second
# DFPWM chunks to jumboaudio.lua on the stadium's speaker computer. Independent of
# the video pipeline on purpose — see castaudio.js's header. CAST_AUDIO=0 to mute
# the whole stadium at the source.
if [ "${CAST_AUDIO:-1}" = "1" ]; then
  node /opt/castaudio.js >> /media/audio.log 2>&1 &
fi

# The same server again for termtv's speaker (:8183), following the termtv leg's
# own source file. A second instance rather than a second port on the first one:
# the two screens can be on different pipelines (different resolved variant of a
# channel, different position in a looping VOD), so each needs its own ffmpeg,
# ring and delay knob. Nothing in castaudio.js is shared state.
if [ "${TERMTV:-1}" = "1" ] && [ "${CAST_AUDIO:-1}" = "1" ]; then
  CAST_AUDIO_PORT="${TERMTV_AUDIO_PORT:-8183}" \
  CAST_AUDIO_SRC="${TERMTV_AUDIO_SRC:-/media/termtv-source}" \
  CAST_AUDIO_DELAY="${TERMTV_AUDIO_DELAY:-8}" \
    node /opt/castaudio.js >> /media/termtv-audio.log 2>&1 &
fi

exec tail -f /dev/null
