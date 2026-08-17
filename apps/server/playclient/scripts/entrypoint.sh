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

# Tell SDL (Controlify's controller backend) it is inside a container, so it
# watches /dev/input with inotify instead of listening for udev events — those
# never arrive in a container's network namespace. Without this, a controller
# that (re)appears mid-game is invisible: Sunshine destroys and recreates its
# virtual pad on every Moonlight reconnect, so the symptom was "controller
# worked on first connect, dead after backing out and re-entering" (2026-08-17).
# /run/host/container-manager is the standard container-interface marker SDL
# checks (SDL_DetectSandbox); done here rather than the Dockerfile so it also
# survives /run ever becoming a tmpfs.
mkdir -p /run/host && touch /run/host/container-manager

if [ "${PLAY_AUTOSTART:-0}" = "1" ] && [ -d /data/main/versions ]; then
  ( sleep 2; /opt/playclient/launch.sh online ) &
fi

exec tail -f /dev/null
