#!/bin/bash
# Keep the live encoder up: sanjuuni listens for the garviscam mpegts feed on
# :8180 and serves CC-format frames on ws://stadiumcast:8177 (compose-internal).
# The listener exits when its input stream ends (e.g. camera restart) — loop it.
set -u
if [ "${CAST_AUTOSTART:-0}" = "1" ]; then
  (
    while true; do
      sanjuuni -f mpegts -i "tcp://0.0.0.0:8180?listen" \
        -W "${CAST_W:-542}" -H "${CAST_H:-414}" -w 8177 -T --disable-opencl \
        >> /media/live.log 2>&1
      echo "[cast] sanjuuni exited, restarting in 3s" >> /media/live.log
      sleep 3
    done
  ) &
fi
exec tail -f /dev/null
