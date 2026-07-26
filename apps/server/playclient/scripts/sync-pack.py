#!/usr/bin/env python3
"""Sync the starting.cc client pack (mounted read-only at /pack) into the
portablemc work dir: download client-supported mods (sha1-verified, skip
up-to-date), prune jars that left the pack, apply mrpack overrides.

Deliberately DIVERGES from garviscam's copy of this script in two ways:

  1. No CAMERA_SKIP. garviscam strips sodium/iris/entityculling because they
     fight llvmpipe software GL. We render on the actual GB10, so those are
     exactly the mods we want — sodium is the single biggest fps win available.

  2. Different EXTRA_MODS. No Baritone (that is Garvis's robot legs, not ours);
     instead Controlify, so a controller paired to the iPhone drives the game
     through Moonlight's gamepad forwarding. Minecraft Java has no native
     controller support, and touch-as-mouse is miserable, so this mod is what
     makes phone play actually playable.

Both extras are CLIENT-ONLY (no server handshake), so they stay out of
apps/client — the shared pack every other player imports is untouched.
"""
import hashlib
import json
import os
import shutil
import sys
import urllib.request
import zipfile

WORK = os.environ.get("PMC_WORK", "/data/work")
index = json.load(open("/pack/modrinth.index.json"))

# Controller support. YACL is Controlify's required dependency (Modrinth
# project 1eAoo2KR) and is NOT in the server pack, so we fetch it ourselves.
EXTRA_MODS = {
    "controlify-2.5.0+1.21.1-neoforge.jar": (
        "https://cdn.modrinth.com/data/DOUdJVEm/versions/d40mkzoo/controlify-2.5.0%2B1.21.1-neoforge.jar",
        "970f8ab301b60b0abd4e476c3577386092a38ad7",
    ),
    "yet_another_config_lib_v3-3.8.2+1.21.1-neoforge.jar": (
        "https://cdn.modrinth.com/data/1eAoo2KR/versions/7TVdVtxF/yet_another_config_lib_v3-3.8.2%2B1.21.1-neoforge.jar",
        "fe270c9f6e0a8142cf316944087f5109cef08bbb",
    ),
}

expected = set()
for f in index["files"]:
    if f.get("env", {}).get("client") == "unsupported":
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
