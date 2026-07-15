# jumbotron — live in-game camera on the Pokémon-stadium screens 📺

A real livestream of the running world, drawn on the 5-face CC monitor jumbotron
(computer 10, "pokemon"). Built & verified live 2026-07-15.

## Architecture (three pieces, two sidecars + one CC program)

```
┌─ garviscam sidecar ────────────┐   mpegts    ┌─ stadiumcast sidecar ─┐   ws frames   ┌─ computer 10 ─┐
│ headless modded MC client      │ ──tcp────▶  │ sanjuuni -T live      │ ──:8177────▶  │ jumboplay.lua │
│ (fat_balls_addict, spectator   │   :8180     │ encode → CC frames    │  (CC http     │ blits to all  │
│ over the field) under Xvfb;    │             │ (542x414, ~5fps)      │   allow-rule) │ monitor faces │
│ ffmpeg x11grab 10fps           │             └───────────────────────┘               └───────────────┘
└────────────────────────────────┘
```

- **garviscam** (`apps/server/garviscam/`): portablemc + NeoForge client + the
  pack (minus sodium/iris/entityculling — GPU-perf mods fight llvmpipe), LWJGL
  **linux-arm64** natives from Maven (Mojang only ships x86_64), Xvfb owned by
  the entrypoint, `camloop.sh` supervises client + capture and auto-accepts the
  server resource-pack prompt (xdotool). MSA session lives in the
  `garviscam-data` volume (one-time `portablemc login <email> --auth-no-browser`).
- **stadiumcast** (`apps/server/stadiumcast/`): sanjuuni built from source;
  live loop = listen :8180 for mpegts → serve CC frames on ws :8177.
- **jumboplay.lua** (this dir): sanjuuni websocket protocol ("n" is a *rolling*
  head counter in live mode — chase it, jump forward when >2s behind), draws
  every attached monitor, auto-reconnects, `cc_stop`/q to stop. In computer
  10's startup.lua.

## Camera control (host-side, via RCON)
```bash
docker exec mc-neoforge rcon-cli "tp fat_balls_addict <x> <y> <z> <yaw> <pitch>"
docker exec mc-neoforge rcon-cli "effect give fat_balls_addict minecraft:night_vision infinite 0 true"
docker exec mc-garviscam /opt/garviscam/snap.sh   # then docker cp .../snap.png — see what the camera sees
```

## Gotchas earned the hard way
- portablemc's NeoForge installer path dies (`KeyError: 'ROOT'`) — use the
  official NeoForge installer into portablemc's main dir, launch the local
  version id (`neoforge-21.1.235`).
- portablemc `-s` = legacy `--server` args; MC 1.20.2+ needs quickPlay, but the
  translation only works when the version JSON declares the feature — verify
  the join happened (`rcon-cli list`), don't trust the flag.
- FML's early-loading window wedges headless GL: `earlyWindowControl=false`.
- CC:T http rule for `stadiumcast` (above the `$private` deny) hot-reloads on
  save — no server restart.
- Editing scripts under `garviscam/scripts/` requires an image rebuild — they
  are COPY'd in (a stale-script launch cost us a silent no-join once).
