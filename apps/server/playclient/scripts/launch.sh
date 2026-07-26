#!/bin/bash
# Launch the modded client onto the HOST's X session, on the GPU.
# Usage: launch.sh [online|offline] [WxH]
#   online:  -l "$PLAYCLIENT_LOGIN" (MSA session cached in /data/work after a
#            one-time `portablemc login`) — joins the real server. The default.
#   offline: -u Player, cannot join an online-mode server — render testing only.
set -euo pipefail
MODE="${1:-online}"
RES="${2:-${PLAY_RES:-2560x1080}}"     # matches the ultrawide, so the phone gets no black bars
NEO_ID="neoforge-21.1.242"

# We do NOT own this display (gdm does) — just wait for it to answer.
for _ in $(seq 1 20); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.5; done
xdpyinfo >/dev/null 2>&1 || { echo "display $DISPLAY not reachable"; exit 1; }

# Sanity: refuse to start on software GL. If the NVIDIA container toolkit did
# not inject the driver, MC would "work" at slideshow fps and the cause would be
# non-obvious hours later. Fail loudly instead.
if command -v glxinfo >/dev/null 2>&1; then
  R=$(glxinfo -B 2>/dev/null | grep -i "OpenGL renderer" || true)
  case "$R" in *llvmpipe*|*softpipe*|*swrast*) echo "REFUSING: software GL ($R)"; exit 1 ;; esac
  echo "GL: $R"
fi

# FML's early loading window mishandles the GL context here — skip it (learned
# in garviscam; harmless on a real GPU and keeps the two clients consistent).
FML_TOML="$PMC_WORK/config/fml.toml"
[ -f "$FML_TOML" ] && sed -i 's/earlyWindowControl = true/earlyWindowControl = false/' "$FML_TOML"

# -Xmx8G: the Cobblemon pack wants ~4GB and this box has 121GB. The librarypath
# points at the arm64 LWJGL natives install.sh fetched (Mojang ships x86_64only).
ARGS=(--main-dir "$PMC_MAIN" --work-dir "$PMC_WORK"
      start "$NEO_ID" --resolution "$RES"
      --jvm-args "-Xmx8G -Xms2G -Dorg.lwjgl.librarypath=/data/lwjgl-arm64")
case "$MODE" in
  online)  ARGS+=(-l "${PLAYCLIENT_LOGIN:?set PLAYCLIENT_LOGIN in apps/server/.env}" -s minecraft) ;;
  offline) ARGS+=(-u Player) ;;
esac
echo "launching $NEO_ID ($MODE, $RES) on $DISPLAY — log: /data/client.log"
exec portablemc "${ARGS[@]}" > /data/client.log 2>&1
