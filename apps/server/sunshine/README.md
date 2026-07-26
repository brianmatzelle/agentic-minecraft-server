# Play the server from the iPhone

The modded client runs **here**, on the Spark's GB10, and only H.264 frames go to
the phone. Two sidecars:

| service      | what it does                                                        |
|--------------|---------------------------------------------------------------------|
| `playclient` | the real NeoForge 1.21.1 client + the 59-mod pack, on hardware GL    |
| `sunshine`   | captures the display, NVENC-encodes it, serves Moonlight             |

Transport is **Tailscale** (`spark-4933` 100.126.150.5 ⇄ `iphone171`, direct,
~41ms) — no router port forward, which matters because UDP forwarding on this
router has never worked (see the Simple Voice Chat revert).

## Why not the obvious alternatives

- **Geyser + Bedrock (App Store).** GeyserMC's own docs: *"Geyser only works with
  server-side mods. Mods that require a client-side install will not work!"*
  Cobblemon is client-side, so the entire point of this server would be
  invisible. Good for walking around and chatting; useless for actually playing.
- **A Java launcher on the phone** (PojavLauncher → its successor Amethyst).
  Needs sideloading + a JIT workaround, doesn't advertise NeoForge, and the pack
  wants ~4GB against iOS per-app memory caps.

## STATUS — not yet playable end to end

Working and verified:

- NVENC on the GB10 — `h264_nvenc` encoded 1280x720@30 at **4.4x realtime**;
  Sunshine reports `Found encoder nvenc: [h264_nvenc, hevc_nvenc]`.
- Hardware GL inside the container — `NVIDIA GB10/PCIe`, `4.6.0 NVIDIA
  580.159.03`, `direct rendering: Yes` (NOT llvmpipe, unlike garviscam).
- The client itself — installs, boots, loads all 59 mods, **Cobblemon loads
  assets**, **Controlify initialises** (SDL3 arm64 natives, 398 gamepad
  mappings), sound engine runs.
- Input injection — Sunshine's virtual devices reach the session: Xorg logs
  `XINPUT: Adding extended input device "Keyboard passthrough"` and
  `"Touchscreen passthrough"` via udev+libinput. **No udev rule or sudo needed**,
  which is the usual stumbling block.
- Web UI reachable over the tailnet (401, i.e. password-gated — see
  `origin_web_ui_allowed` in `sunshine.conf` for the CGNAT trap).

Blocked:

- **X11 capture returns pure black**, so Moonlight would show a black screen.
  Fully diagnosed in the header of `sunshine.conf` — the root window has no
  readable pixels while individual windows do, and the compositor, DPMS, the
  game, and shm/uid were each ruled out with a forced repaint. The fix is KMS
  capture, which needs `nvidia-drm modeset=1` + `update-initramfs -u` + a
  **reboot** (and then `cap_add: [SYS_ADMIN]` here). The reboot drops the
  Minecraft server for a few minutes, so it is a deliberate owner decision.

## Setup

One-time, after the KMS reboot above:

```bash
cd apps/server

# 1. Microsoft login for the client (device-code flow, prints a URL + code).
#    Set PLAYCLIENT_LOGIN in .env first.
docker exec -it mc-playclient portablemc login "$PLAYCLIENT_LOGIN"

# 2. Install game files + NeoForge + the pack (~2GB, several minutes).
docker exec mc-playclient /opt/playclient/install.sh

# 3. Sunshine web UI login. Already set to user `garvis`; to rotate:
docker exec mc-sunshine /usr/bin/sunshine /config/sunshine.conf --creds garvis '<new-password>'
```

Then, to play:

```bash
docker exec -d mc-playclient /opt/playclient/launch.sh online   # start the game
docker exec mc-playclient tail -f /data/client.log              # watch it boot
```

In game, the server address is **`minecraft:25565`** (the compose network name).

On the phone: install **Moonlight**, make sure Tailscale is up, add host
`100.126.150.5`. Moonlight shows a PIN → enter it at
`https://100.126.150.5:47990` (log in as `garvis`) to pair.

Set `PLAY_AUTOSTART=1` in `.env` once you trust it, so the game is already
running when you pick up the phone with no laptop in reach.

## Controller

Minecraft Java has no native controller support and touch-as-mouse is miserable,
so `playclient/scripts/sync-pack.py` adds **Controlify** (+ its YACL dependency)
as client-only extras — they are deliberately NOT in `apps/client`, so the pack
everyone else imports is untouched. Pair a Bluetooth controller (Backbone, Xbox,
DualSense) to the *iPhone*; Moonlight forwards it as a gamepad.

Controlify logs one non-fatal error on boot:
`InvalidMixinException: Found a remappable @Shadow annotation on
getRecipeBookComponent`. It is a known upstream conflict and only disables
virtual-mouse snapping in the recipe book — the mod otherwise initialises fine.

## Landmines

- **The upstream Sunshine arm64 image does not run.** `ghcr.io/lizardbyte/sunshine`
  is missing `libva.so.2`, `libva-drm2`, `libwayland-client0`, `libgbm1`,
  `libXrandr` and more — it exits instantly on the first and dies with
  "Couldn't init x11 libraries" once that is fixed. `./Dockerfile` installs the
  official .deb's full dependency set. Upstream does warn that "the Docker
  images are not recommended for most users."
- **Sunshine state must be pinned to `/config`.** `HOME` is `/home/lizard` in
  that image, so without the explicit `file_state`/`credentials_file`/`pkey`/
  `cert` lines it writes pairing + TLS certs to an unpersisted path and the
  phone silently needs re-pairing after every rebuild.
- **`capture` is not a valid config key in this build** — it warns
  "Unrecognized configurable option" and auto-detects instead.
- **This is the owner's real desktop, not a private seat.** Capture and input
  both land on seat0 (i3, ultrawide, Prism Launcher, terminals). Streaming means
  the physical monitor shows the same thing and the phone drives the same
  session. Fine when nobody is at the desk.
- **X's idle timer is input-based**, so a rendering game does not stop the
  screen blanking after an hour (`xset q`: timeout 3600, DPMS 3600). Once KMS
  capture is in, verify whether a blanked screen still streams; if not, a
  Sunshine `global_prep_cmd` running `xset dpms force on` is the surgical fix.
