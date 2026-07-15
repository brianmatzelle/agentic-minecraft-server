#!/bin/bash
# Camera supervisor: keep the online client + ffmpeg capture running forever.
# Started via `docker exec -d mc-garviscam /opt/garviscam/camloop.sh` (or by the
# entrypoint when CAM_AUTOSTART=1). Handles the post-join niceties: accepting
# the server resource-pack prompt (fixed button coords at 960x540) and F1.
set -u
RES="${XVFB_RES:-960x540}"

capture_loop() {
  while true; do
    ffmpeg -loglevel warning -f x11grab -framerate 10 -video_size "$RES" -i :99 \
      -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p \
      -f mpegts tcp://stadiumcast:8180 >> /data/capture.log 2>&1
    echo "[camloop] ffmpeg exited, retrying in 5s" >> /data/capture.log
    sleep 5
  done
}

postjoin_clicker() {
  # For ~3 min after each client start: accept the resource-pack prompt if it
  # appears, then hide the HUD. Blind clicks at these coords are harmless on
  # other screens (no button there on title/loading/world screens).
  for _ in $(seq 1 12); do
    sleep 15
    W=$(DISPLAY=:99 xdotool search --class Minecraft 2>/dev/null | head -1) || continue
    [ -n "${W:-}" ] || continue
    DISPLAY=:99 xdotool mousemove 320 350 click 1 2>/dev/null
  done
  W=$(DISPLAY=:99 xdotool search --class Minecraft 2>/dev/null | head -1)
  [ -n "${W:-}" ] && DISPLAY=:99 xdotool key --window "$W" F1 2>/dev/null
}

capture_loop &
while true; do
  postjoin_clicker &
  /opt/garviscam/launch.sh online "$RES"
  echo "[camloop] client exited, relaunching in 15s" >> /data/capture.log
  sleep 15
done
