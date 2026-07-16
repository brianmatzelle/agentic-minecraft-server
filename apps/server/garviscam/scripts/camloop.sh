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

stream_loop() {
  # Second, independent capture: video + game audio → Owncast (Garvis TV web
  # page). Separate encode so the jumbotron chain above is never disturbed.
  # Audio comes from the mcsink null sink's monitor (see entrypoint.sh); if
  # PulseAudio is down this ffmpeg fails outright — by design, it retries.
  # Kill switch: GARVIS_STREAM=0. Key comes from OWNCAST_STREAM_KEY in .env.
  [ "${GARVIS_STREAM:-1}" = "1" ] || return 0
  [ -n "${OWNCAST_STREAM_KEY:-}" ] || { echo "[camloop] OWNCAST_STREAM_KEY unset — web stream disabled" >> /data/stream.log; return 0; }
  while true; do
    ffmpeg -loglevel warning \
      -f x11grab -framerate 10 -video_size "$RES" -i :99 \
      -f pulse -i mcsink.monitor \
      -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p \
      -g 20 -b:v 2000k -maxrate 2500k -bufsize 4000k \
      -c:a aac -b:a 128k -ar 44100 \
      -f flv "rtmp://owncast:1935/live/${OWNCAST_STREAM_KEY}" >> /data/stream.log 2>&1
    echo "[camloop] stream ffmpeg exited, retrying in 10s" >> /data/stream.log
    sleep 10
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

respawn_watcher() {
  # Two wedge states park the client on a dead screen (chat dead, stream
  # frozen) until something intervenes; watch latest.log for their signatures.
  # tail -F survives the log being recreated on client relaunch.
  # - Death screen: Baritone logs "Death position saved." the moment we die —
  #   click Respawn at its fixed coords (centered at 960x540; same fixed-layout
  #   assumption as the resource-pack click above).
  # - Connection Lost screen: any server-side drop (kick, netty error, server
  #   stop) logs "Client disconnected with reason:" — no button worth clicking,
  #   kill the client and let the relaunch loop below rejoin. If the server is
  #   down the relaunch just retries on its own 15s cadence.
  tail -F /data/work/logs/latest.log 2>/dev/null | while read -r line; do
    case "$line" in
      *"Death position saved"*)
        sleep 2
        DISPLAY=:99 xdotool mousemove 480 297 click 1 2>/dev/null
        echo "[camloop] death detected — clicked Respawn" >> /data/capture.log
        ;;
      *"Client disconnected with reason"*)
        echo "[camloop] server disconnect detected — relaunching client" >> /data/capture.log
        sleep 5
        pkill -x java
        ;;
    esac
  done
}

capture_loop &
stream_loop &
respawn_watcher &
while true; do
  postjoin_clicker &
  /opt/garviscam/launch.sh online "$RES"
  echo "[camloop] client exited, relaunching in 15s" >> /data/capture.log
  sleep 15
done
