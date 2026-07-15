#!/bin/bash
# Launch the modded client under Xvfb. Usage: launch.sh [offline|online] [WxH]
# offline: -u GarvisCam, can't join online-mode servers — render testing only.
# online:  -l "$GARVISCAM_LOGIN" (MSA session cached in /data/work after
#          `portablemc login`), joins the real server.
set -euo pipefail
MODE="${1:-offline}"
RES="${2:-960x540}"
NEO_ID="neoforge-21.1.235"

# display is owned by the container entrypoint — just wait for it
for _ in $(seq 1 20); do xdpyinfo -display :99 >/dev/null 2>&1 && break; sleep 0.5; done
xdpyinfo -display :99 >/dev/null 2>&1 || { echo "display :99 not up"; exit 1; }
export LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe

# FML's early loading window mishandles headless GL contexts — skip it.
FML_TOML="$PMC_WORK/config/fml.toml"
[ -f "$FML_TOML" ] && sed -i 's/earlyWindowControl = true/earlyWindowControl = false/' "$FML_TOML"

ARGS=(--main-dir "$PMC_MAIN" --work-dir "$PMC_WORK"
      start "$NEO_ID" --resolution "$RES"
      --jvm-args "-Xmx6G -Xms2G -Dorg.lwjgl.librarypath=/data/lwjgl-arm64")
case "$MODE" in
  offline) ARGS+=(-u GarvisCam) ;;
  online)  ARGS+=(-l "${GARVISCAM_LOGIN:?set GARVISCAM_LOGIN}" -s minecraft) ;;
esac
echo "launching $NEO_ID ($MODE, $RES) — log: /data/client.log"
exec portablemc "${ARGS[@]}" > /data/client.log 2>&1
