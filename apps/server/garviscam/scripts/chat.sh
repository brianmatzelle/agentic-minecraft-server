#!/bin/bash
# Type one line into the running MC client's chat via xdotool: plain text goes
# to server chat, "#..." lines are intercepted client-side by Baritone.
# Usage: chat.sh '<line>' — client must be in-world with no GUI open
# (snap.sh to check; Baritone replies land in /data/work/logs/latest.log [CHAT]).
set -eu
export DISPLAY=:99
W=$(xdotool search --class Minecraft | head -1)
[ -n "$W" ] || { echo "no Minecraft window" >&2; exit 1; }
xdotool key --window "$W" t
sleep 0.5
xdotool type --window "$W" --delay 40 "$1"
sleep 0.3
xdotool key --window "$W" Return
