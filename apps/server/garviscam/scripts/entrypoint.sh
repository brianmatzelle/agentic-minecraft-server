#!/bin/bash
# Container entrypoint: keep the virtual display up as a first-class process so
# game launches/crashes never take it down. XVFB_RES is set in docker-compose.
set -euo pipefail
RES="${XVFB_RES:-960x540}"
Xvfb :99 -screen 0 "${RES}x24" -nolisten tcp &
if [ "${CAM_AUTOSTART:-0}" = "1" ] && [ -d /data/main/versions ]; then
  sleep 2
  /opt/garviscam/camloop.sh &
fi
exec tail -f /dev/null
