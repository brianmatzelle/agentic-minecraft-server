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
  live loop = listen :8180 for mpegts → serve CC frames on ws :8177. The
  source is switchable since 2026-07-23 (`/opt/source.sh live|bloomberg`,
  state in `/media/source`, persists across restarts): `bloomberg` swaps the
  camera feed for Bloomberg TV's public HLS stream
  (`bloomberg.com/media-manifest/streams/us.m3u8`, found via iptv-org's
  streams.json like the termtv app; `BLOOMBERG_URL` env overrides) — an
  in-container ffmpeg downsamples it to 10fps/542x414 (the known-good
  sanjuuni load, camloop's codec recipe) and pushes mpegts to sanjuuni on
  127.0.0.1:8181. garviscam's :8180 push gets connection-refused meanwhile
  (camloop retries forever — camera client and Owncast stream unaffected).
  Landmine: sanjuuni `-T` encodes only as the ws client REQUESTS frames — no
  jumboplay connected (stadium chunk unloaded) = sanjuuni parked at
  `frame 0/0`, ffmpeg's tcp send-queue backed up. Idle, not broken.
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

## Garvis plays (Baritone)
The camera account doubles as a playable body. `baritone-standalone-neoforge`
v1.11.2 (= MC 1.21/1.21.1; client-only, no server handshake) is pulled in by
sync-pack.py's `EXTRA_MODS` (sha1-pinned, exempt from pruning). Control plane =
`chat.sh` (xdotool types into the client's chat): plain lines go to public
chat as fat_balls_addict, `#` lines are Baritone commands intercepted
client-side — `#follow player <name>`, `#goto x y z`, `#stop`, `#set`.
RCON `gamemode survival|spectator` flips player ↔ camera; in player mode the
jumbotron streams Garvis's first-person POV. Since 2026-07-15 the body REALLY
plays: `allowBreak`/`allowPlace`/`allowInventory` are true (owner unlock,
persisted in `work/baritone/settings.txt` — revert with `#set allowBreak
false` etc. if pathing eats a build). Players command the body in-game via the
`!g` body intent (apps/garvis-bot/src/body.js), and garvis-bot runs his
survival reflexes host-side, both polling rcon each minute: hunger.js (eat.sh
= select slot + hold right-click when foodLevel dips; slot 9 lunchbox) and
sleep.js (at night: #stop, tp-in-place to AIM at the ground ahead — the only
deterministic way to point a headless client — then eat.sh on a carried bed:
the press places it, the held repeat-use climbs in; bed reclaimed at dawn via
guarded setblock-destroy; nearby phantoms rcon-killed first since they'd veto
the sleep). Kill switches: GARVIS_BODY_AUTOEAT / GARVIS_BODY_AUTOSLEEP.
Hard-won: chat.sh serializes typists with flock (concurrent typings interleave
keystrokes into one line and leak the rest in-world — a stray 'e' opens the
inventory and wedges chat); `#follow player` only binds targets the client has
LOADED (entity tracking ~60 blocks — tp close first, body.js does); deaths are
self-healed by camloop's respawn_watcher (Baritone's "Death position saved."
line → click Respawn at (480,297)@960x540), and Connection Lost screens too
("Client disconnected with reason:" in latest.log → pkill java → relaunch loop
rejoins; fires on kicks, netty errors, and server stops alike). Baritone
forgets its task on relaunch — re-issue #follow/#goto after a self-heal.
Why not Mineflayer/minecraft-mcp-server: vanilla protocol can't pass the
NeoForge required-mod registry handshake (and that wrapper is offline-auth
only) — a real modded client was the only way in, and we already had one.

## Web stream — Garvis TV (Owncast)
The same camera also streams to the web, with game audio, at
**https://tv.starting.cc** — served through the HOST's existing cloudflared
tunnel (user unit `writing-tunnel.service`, ingress in
`~/.cloudflared/config.yml` → localhost:8088), so no router port is open;
owncast's 8088 binding is 127.0.0.1-only:

    Xvfb :99 ──x11grab──┐
                        ├─ ffmpeg #1 → mpegts → stadiumcast (jumbotron, video only)
    pulse null sink ────┤
    "mcsink" (audio) ───┴─ ffmpeg #2 → RTMP → mc-owncast → HLS watch page
                                               127.0.0.1:8088 ← cloudflared
                                               → https://tv.starting.cc

- Audio: entrypoint.sh starts PulseAudio with a null sink (`mcsink`) BEFORE the
  client launches; MC's OpenAL binds to it (`OpenAL initialized on device
  mcsink` in latest.log). If pulse ever starts late, the client renders
  silence until a java restart. ffmpeg #2 captures `mcsink.monitor`.
- streamloop.sh (split out of camloop.sh 2026-07-16) owns ffmpeg #2 —
  independent of the jumbotron capture, retries every 10s, logs to
  /data/stream.log (audio setup: /data/audio.log). Kill switch:
  `GARVIS_STREAM=0` in garviscam's env. Hot-restart WITHOUT bouncing the
  client (body stays in-game): docker cp the script in, kill the running
  ffmpeg AND its parent bash (pgrep -f rtmp → ps -o ppid=), then
  `docker exec -d mc-garviscam /opt/garviscam/streamloop.sh`.
- Secrets: `OWNCAST_STREAM_KEY` + `OWNCAST_ADMIN_PASSWORD` in apps/server/.env
  (gitignored, nowhere else). Admin panel: `http://<host>:8088/admin`, user
  `admin`. The `-streamkey` flag is per-session — compose re-asserts it from
  .env every start, so rotating = edit .env + restart both containers.
- Health: `curl -s localhost:8088/api/status | jq .online` — flips true ~10s
  after ffmpeg #2 connects. Restart layer: `docker compose restart owncast`.
- LATENCY (tuned 2026-07-16, ~7–10s glass-to-glass): Owncast runs the feed as
  video PASSTHROUGH at HLS latency level 1 (2s segments) — set via admin API,
  persisted in apps/server/owncast/brand.sh (config-state; applies on next
  inbound connect — hot-reconnect: `pkill -f "rtmp[:]//owncast"` in
  mc-garviscam, NEVER `pkill -x ffmpeg` which also kills the jumbotron feed
  and wedges stadiumcast's one-shot :8180 listen; the [:] keeps pkill from
  matching its own cmdline). Passthrough slices segments on keyframes only,
  and under llvmpipe load the real capture rate sags to ~3–5fps, so `-g`
  (frames) is NOT enough — streamloop.sh pins keyframes to 1s of wall-clock
  with `-force_key_frames "expr:gte(t,n_forced*1)"`. Segments must probe ≈2s
  (`curl -s localhost:8088/hls/0/stream.m3u8 | grep EXTINF`). Level 0 (1s
  segments, ~4–6s) was tried and BUFFERED even on the owner's connection —
  1s fetch cadence through the CF tunnel starves the tiny player buffer;
  don't retry. Still buffering → level 2.
- Viewers can PAY to command Garvis from the stream chat (x402/USDC credits →
  body verbs + TV): the tollbooth sidecar, `apps/server/tollbooth/README.md`.

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
