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

## STATUS — working since the 2026-08-17 KMS reboot

The `nvidia-drm modeset=1` + initramfs + reboot fix was applied 2026-08-17 and
it cured the black capture — but not the way we expected: Sunshine still logs
"Screencasting with X11" (no KMS grab, `Couldn't load EGL library` in this
image), yet with modeset on, the X root window now HAS readable pixels
(`xwd -root`: 8.3M nonzero bytes of 11M, was 0 of 4M). So the broken thing was
the driver's root-window backing under modeset=0, and X11 capture is fine now.

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

- The MSA login + auto-join (`launch.sh online`) — proven E2E 2026-08-17.

## Setup

One-time:

```bash
cd apps/server

# 1. Microsoft login for the client (device-code flow, prints a URL + code).
#    Set PLAYCLIENT_LOGIN in .env first.
#    --work-dir is NOT optional: portablemc keys its auth database off the WORK
#    dir (cli/__init__.py: `AuthDatabase(ns.context.work_dir / ...)`), and
#    launch.sh starts the game with --work-dir /data/work. A login without it
#    lands the session in the wrong file and `launch.sh online` fails with a
#    bare "[FAILED] Failed to authenticate." (learned the hard way 2026-08-17).
docker exec -it mc-playclient portablemc --main-dir /data/main --work-dir /data/work login "$PLAYCLIENT_LOGIN"

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
DualSense) to the *phone/iPad*; Moonlight forwards it as a gamepad, and
Moonlight's on-screen touch overlay speaks the same gamepad protocol.

How the events actually reach the game — and why each hop exists:

- Keyboard and mouse go **through X**: Sunshine writes them to its virtual
  uinput devices, host udev hands them to Xorg, Xorg delivers to the focused
  window. This hop works with zero playclient config, which is why mouse/typing
  worked before controllers did (2026-08-17).
- Gamepads do NOT go through X — games read them **straight from
  `/dev/input/event*`**. Sunshine creates the virtual pad on the HOST only when
  a Moonlight session attaches a controller (mid-session!), so playclient
  bind-mounts the whole `/dev/input` directory plus a
  `device_cgroup_rules: c 13:* rmw` to be allowed to open nodes that did not
  exist at container create.
- Even then, SDL's *hotplug* is udev-based, and udev events never arrive in a
  container's network namespace — so the pad was seen at game boot but a pad
  created later was invisible. Since Sunshine destroys + recreates its virtual
  pad on **every** Moonlight reconnect, that meant "worked once, dead after
  backing out and re-entering". Fix: `entrypoint.sh` touches
  `/run/host/container-manager`, the standard marker SDL's sandbox detection
  checks — SDL then drops udev and watches `/dev/input` with inotify, which
  works across the bind mount. (Removal was always detected — a dead open fd
  announces itself — which is why the log showed disconnects but never
  reconnects. That asymmetry is the fingerprint of this bug.)

Controlify logs one non-fatal error on boot:
`InvalidMixinException: Found a remappable @Shadow annotation on
getRecipeBookComponent`. It is a known upstream conflict and only disables
virtual-mouse snapping in the recipe book — the mod otherwise initialises fine.

## Landmines

- **"Only the mouse works" from Moonlight = the gamepad device is invisible to
  the game container.** Mouse/keyboard ride through Xorg; the controller is a
  raw `/dev/input` device the game must open itself. If playclient ever loses
  its `/dev/input` bind mount or the `c 13:* rmw` cgroup rule, you get exactly
  that split symptom (cost a session 2026-08-17). Check with
  `docker exec mc-playclient ls /dev/input`.
- **The X display number moves between boots.** gdm's user session picks the
  first free display (`-displayfd`): it was `:1` for months, then `:0` after
  the 2026-08-17 reboot. A stale `SUNSHINE_DISPLAY` (in `.env`, feeds both this
  service and playclient) makes Sunshine **crash-loop** — the tell is the log
  cycling config-dump → "Detecting connected monitors" every ~500ms. Check the
  real display with `pgrep -a Xorg` / `who`.
- **These two containers lose the boot race.** At host boot, docker can create
  them before the NVIDIA driver is loaded; the create fails (`nvml error:
  driver not loaded`, exit 128) and a failed *create* is not retried by the
  restart policy. After a reboot, `docker compose up -d sunshine playclient`.

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
