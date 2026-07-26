#!/bin/bash
# One-time install: vanilla files + NeoForge + the client pack, all into /data.
# Mirrors garviscam/scripts/install.sh — the two aarch64 workarounds below were
# learned there and are NOT optional on this box.
set -euo pipefail
MC_VERSION=1.21.1
NEO_VERSION=21.1.242          # must match the server's .env NEOFORGE_VERSION pin

echo "== vanilla $MC_VERSION files =="
portablemc --main-dir "$PMC_MAIN" --work-dir "$PMC_WORK" start --dry -u Player "$MC_VERSION"

echo "== NeoForge $NEO_VERSION (official installer; portablemc's neoforge path hits KeyError:ROOT) =="
if [ ! -d "$PMC_MAIN/versions/neoforge-$NEO_VERSION" ]; then
  curl -sL -o /tmp/nf-installer.jar \
    "https://maven.neoforged.net/releases/net/neoforged/neoforge/$NEO_VERSION/neoforge-$NEO_VERSION-installer.jar"
  [ -f "$PMC_MAIN/launcher_profiles.json" ] || echo '{"profiles":{}}' > "$PMC_MAIN/launcher_profiles.json"
  java -jar /tmp/nf-installer.jar --install-client "$PMC_MAIN"
  rm -f /tmp/nf-installer.jar
fi

echo "== LWJGL linux-arm64 natives (Mojang manifests only ship x86_64) =="
NAT_DIR=/data/lwjgl-arm64
mkdir -p "$NAT_DIR"
find "$PMC_MAIN/libraries/org/lwjgl" -name "*-natives-linux.jar" | while read -r j; do
  base=$(basename "$j" .jar)
  core=${base%-natives-linux}
  ver=${core##*-}
  mod=${core%-"$ver"}
  url="https://repo1.maven.org/maven2/org/lwjgl/$mod/$ver/$mod-$ver-natives-linux-arm64.jar"
  echo "  $mod $ver"
  curl -sfL -o /tmp/nat.jar "$url"
  unzip -oq /tmp/nat.jar "linux/arm64/*" -d /tmp/natx
  find /tmp/natx -name "*.so" -exec cp {} "$NAT_DIR"/ \;
  rm -rf /tmp/nat.jar /tmp/natx
done
ls "$NAT_DIR"

echo "== client pack sync (+ Controlify) =="
python3 /opt/playclient/sync-pack.py

echo "install complete"
