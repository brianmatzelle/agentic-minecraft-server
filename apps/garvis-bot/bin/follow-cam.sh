#!/usr/bin/env bash
# follow-cam.sh — keep the spectator body glued to a player so the jumbotron
# acts as a live CCTV cam. Re-teleports fat_balls_addict onto <target> forever.
#
#   usage:  follow-cam.sh <target> [interval_seconds]
#   stop:   touch /tmp/follow-cam.stop
set -euo pipefail

TARGET="${1:?usage: follow-cam.sh <target> [interval]}"
INTERVAL="${2:-5}"
RCON="$(cd "$(dirname "$0")" && pwd)/rcon"
STOP="/tmp/follow-cam.stop"

# Minecraft usernames only — guards against anything sneaking into the rcon line.
if ! [[ "$TARGET" =~ ^[A-Za-z0-9_]{1,16}$ ]]; then
  echo "refusing suspicious target: $TARGET" >&2
  exit 1
fi

rm -f "$STOP"
"$RCON" "gamemode spectator fat_balls_addict" >/dev/null 2>&1 || true

while [ ! -f "$STOP" ]; do
  "$RCON" "tp fat_balls_addict $TARGET" >/dev/null 2>&1 || true
  sleep "$INTERVAL"
done

echo "follow-cam stopped"
