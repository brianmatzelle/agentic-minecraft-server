#!/bin/bash
# Garvis TV web-stream encoder: video + game audio → Owncast (split out of
# camloop.sh so the stream can be restarted/retuned WITHOUT bouncing the
# whole client — the body stays in-game). Started by camloop.sh in the
# background; hot restart = docker cp this file in, kill the running loop's
# ffmpeg AND its parent bash, then `docker exec -d mc-garviscam /opt/garviscam/streamloop.sh`.
#
# Separate encode so the jumbotron chain (camloop capture_loop) is never
# disturbed. Audio comes from the mcsink null sink's monitor (see
# entrypoint.sh); if PulseAudio is down this ffmpeg fails outright — by
# design, it retries. Kill switch: GARVIS_STREAM=0. Key: OWNCAST_STREAM_KEY.
#
# LATENCY (2026-07-16): Owncast runs this feed as video PASSTHROUGH at its
# lowest HLS latency level (see ../owncast/brand.sh) and slices segments on
# keyframes only, so keyframe cadence == segment length == viewer latency.
# -force_key_frames pins keyframes to 1s of WALL-CLOCK time; -g alone counts
# frames, and under llvmpipe load the real capture rate sags to ~3-5fps,
# which silently stretched "1s" GOPs into 2-7s segments.
#
# QUALITY (2026-07-18): 1s keyframes need VBV headroom — bufsize 2000k
# underflowed on every keyframe (visible ~1Hz quality pulsing), and the
# default input thread queue (8) stalled x11grab, dropping delivered fps
# to ~6.5; hence bufsize 4000k + -thread_queue_size 64 on both live inputs.
set -u
RES="${XVFB_RES:-960x540}"

[ "${GARVIS_STREAM:-1}" = "1" ] || exit 0
[ -n "${OWNCAST_STREAM_KEY:-}" ] || { echo "[streamloop] OWNCAST_STREAM_KEY unset — web stream disabled" >> /data/stream.log; exit 0; }
while true; do
  ffmpeg -loglevel warning \
    -thread_queue_size 64 -f x11grab -framerate 10 -video_size "$RES" -i :99 \
    -thread_queue_size 64 -f pulse -i mcsink.monitor \
    -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p \
    -g 10 -force_key_frames "expr:gte(t,n_forced*1)" \
    -b:v 2000k -maxrate 3000k -bufsize 4000k \
    -c:a aac -b:a 128k -ar 44100 \
    -f flv "rtmp://owncast:1935/live/${OWNCAST_STREAM_KEY}" >> /data/stream.log 2>&1
  echo "[streamloop] stream ffmpeg exited, retrying in 10s" >> /data/stream.log
  sleep 10
done
