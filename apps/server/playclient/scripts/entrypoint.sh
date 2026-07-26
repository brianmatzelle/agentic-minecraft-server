#!/bin/bash
# Container entrypoint. Like garviscam, this container IDLES by default and is
# driven from outside:
#     docker exec mc-playclient /opt/playclient/install.sh     # one-time
#     docker exec mc-playclient portablemc login <you@…>       # one-time (MSA)
#     docker exec -d mc-playclient /opt/playclient/launch.sh   # start the game
#
# It does NOT own the display — gdm's Xorg on :1 does — so there is nothing to
# supervise here and a game crash can't take anything else down.
#
# PLAY_AUTOSTART=1 launches the game on container start, which is what makes
# "pick up the phone and play" work without a laptop to run the exec.
set -euo pipefail

if [ "${PLAY_AUTOSTART:-0}" = "1" ] && [ -d /data/main/versions ]; then
  ( sleep 2; /opt/playclient/launch.sh online ) &
fi

exec tail -f /dev/null
