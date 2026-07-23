#!/bin/bash
# Keep the live encoder up. The jumbotron source is switchable (/media/source,
# default "live"; flip with /opt/source.sh — kills the pipeline, this loop
# re-reads the file and starts the new one):
#   live      — sanjuuni listens on :8180 for the garviscam mpegts push
#   bloomberg — in-container ffmpeg pulls Bloomberg TV's public HLS feed,
#               downsamples to 10fps/542x414 (the known-good sanjuuni load,
#               same codec recipe as camloop's push) and pushes mpegts to
#               sanjuuni on 127.0.0.1:8181. garviscam's :8180 push just gets
#               connection-refused meanwhile — camloop already retries forever.
# sanjuuni exits when its input stream ends (camera restart, HLS drop) — loop it.
set -u

W="${CAST_W:-542}"
H="${CAST_H:-414}"
# Bloomberg's own manifest (via iptv-org's streams.json, same source the termtv
# app uses). If it ever dies, re-resolve: jq '.[] | select(.channel ==
# "BloombergTV.us") | .url' streams.json — or override via compose env.
BLOOMBERG_URL="${BLOOMBERG_URL:-https://bloomberg.com/media-manifest/streams/us.m3u8}"

if [ "${CAST_AUTOSTART:-0}" = "1" ]; then
  (
    while true; do
      SRC=$(cat /media/source 2>/dev/null || echo live)
      case "$SRC" in
        bloomberg)
          sanjuuni -f mpegts -i "tcp://127.0.0.1:8181?listen" \
            -W "$W" -H "$H" -w 8177 -T --disable-opencl >> /media/live.log 2>&1 &
          SANJUUNI=$!
          sleep 2   # let the listener bind before ffmpeg dials
          ffmpeg -hide_banner -loglevel warning \
            -i "$BLOOMBERG_URL" -map 0:v:0 -an -sn -dn \
            -vf "fps=10,scale=${W}:${H}" \
            -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p \
            -f mpegts tcp://127.0.0.1:8181 >> /media/bloomberg.log 2>&1
          kill "$SANJUUNI" 2>/dev/null
          wait "$SANJUUNI" 2>/dev/null
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
