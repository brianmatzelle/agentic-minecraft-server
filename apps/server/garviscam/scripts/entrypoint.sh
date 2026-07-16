#!/bin/bash
# Container entrypoint: keep the virtual display up as a first-class process so
# game launches/crashes never take it down. XVFB_RES is set in docker-compose.
set -euo pipefail
RES="${XVFB_RES:-960x540}"
Xvfb :99 -screen 0 "${RES}x24" -nolisten tcp &
# Virtual audio device: a PulseAudio null sink the client's OpenAL binds to
# (there's no real sound hardware here). Its .monitor source is what the web
# stream captures for game audio. Must exist BEFORE the client launches, or MC
# initializes on OpenAL's null backend and renders silence until restarted.
# Best-effort: audio failing must never take down the camera.
{
  pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit || true
  sleep 1
  pactl load-module module-null-sink sink_name=mcsink sink_properties=device.description=mcsink || true
  pactl set-default-sink mcsink || true
} >> /data/audio.log 2>&1
if [ "${CAM_AUTOSTART:-0}" = "1" ] && [ -d /data/main/versions ]; then
  sleep 2
  /opt/garviscam/camloop.sh &
fi
exec tail -f /dev/null
