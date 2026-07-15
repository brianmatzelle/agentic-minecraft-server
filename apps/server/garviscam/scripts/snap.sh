#!/bin/bash
# Grab one frame of the virtual display to /data/snap.png (agent-readable).
set -euo pipefail
SIZE=$(xdpyinfo -display :99 | awk '/dimensions/{print $2}')
ffmpeg -y -loglevel error -f x11grab -video_size "$SIZE" -i :99 -frames:v 1 /data/snap.png
echo "written /data/snap.png ($SIZE)"
