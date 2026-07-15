#!/bin/bash
# Eat from a hotbar slot: select it, hold right-click long enough to finish
# one eat (~1.6s), release. Usage: eat.sh [slot 1-9] (default 9 — the lunchbox
# slot the garvis-bot hunger watcher keeps stocked). Only makes sense while
# in-world, in survival, and actually hungry — the watcher checks all of that
# over rcon before calling us. Shares chat.sh's lock so an eat can never
# interleave with a typist (chat.sh header has the war story).
set -eu
SLOT="${1:-9}"
case "$SLOT" in [1-9]) ;; *) echo "slot must be 1-9" >&2; exit 1 ;; esac
export DISPLAY=:99
exec 9>/tmp/chat.sh.lock
flock 9
W=$(xdotool search --class Minecraft | head -1)
[ -n "$W" ] || { echo "no Minecraft window" >&2; exit 1; }
xdotool key --window "$W" "$SLOT"
sleep 0.3
xdotool mousedown --window "$W" 3
sleep 2.2
xdotool mouseup --window "$W" 3
