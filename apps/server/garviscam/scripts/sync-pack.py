#!/usr/bin/env python3
"""Sync the starting.cc client pack (mounted read-only at /pack) into the
portablemc work dir: download client-supported mods (sha1-verified, skip
up-to-date), prune jars that left the pack, apply mrpack overrides."""
import hashlib
import json
import os
import shutil
import sys
import urllib.request
import zipfile

WORK = os.environ.get("PMC_WORK", "/data/work")
index = json.load(open("/pack/modrinth.index.json"))

# GPU-perf mods (pure client-render, no server handshake) crash/fight llvmpipe
# software GL — the camera runs without them.
CAMERA_SKIP = ("sodium", "iris", "entityculling")

# Client-only extras NOT in the server pack (no server handshake, so safe to
# add unilaterally). Baritone = pathfinding legs for Garvis-plays mode.
EXTRA_MODS = {
    "baritone-standalone-neoforge-1.11.2.jar": (
        "https://github.com/cabaletta/baritone/releases/download/v1.11.2/baritone-standalone-neoforge-1.11.2.jar",
        "5fe6aafcf6ebb38cc956a11a8410dd6bc6734d31",
    ),
}

expected = set()
for f in index["files"]:
    if f.get("env", {}).get("client") == "unsupported":
        continue
    base = os.path.basename(f["path"]).lower()
    if any(s in base for s in CAMERA_SKIP):
        continue
    expected.add(os.path.basename(f["path"]))
    dest = os.path.join(WORK, f["path"])
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    want = f["hashes"]["sha1"]
    if os.path.exists(dest):
        if hashlib.sha1(open(dest, "rb").read()).hexdigest() == want:
            continue
    print("fetch", f["path"], flush=True)
    urllib.request.urlretrieve(f["downloads"][0], dest)
    if hashlib.sha1(open(dest, "rb").read()).hexdigest() != want:
        sys.exit(f"hash mismatch: {f['path']}")

for name, (url, want) in EXTRA_MODS.items():
    expected.add(name)
    dest = os.path.join(WORK, "mods", name)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest) and hashlib.sha1(open(dest, "rb").read()).hexdigest() == want:
        continue
    print("fetch extra", name, flush=True)
    urllib.request.urlretrieve(url, dest)
    if hashlib.sha1(open(dest, "rb").read()).hexdigest() != want:
        sys.exit(f"hash mismatch: {name}")

mods_dir = os.path.join(WORK, "mods")
if os.path.isdir(mods_dir):
    for j in os.listdir(mods_dir):
        if j.endswith(".jar") and j not in expected:
            print("prune", j, flush=True)
            os.remove(os.path.join(mods_dir, j))

mrpack = "/pack/starting-cc-client.mrpack"
if os.path.exists(mrpack):
    with zipfile.ZipFile(mrpack) as z:
        for n in z.namelist():
            if n.startswith("overrides/") and not n.endswith("/"):
                dest = os.path.join(WORK, n[len("overrides/"):])
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with z.open(n) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)

print("pack synced:", len(expected), "mods")
