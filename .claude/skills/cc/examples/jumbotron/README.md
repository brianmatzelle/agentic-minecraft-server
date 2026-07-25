# jumbotron — live in-game camera on the Pokémon-stadium screens 📺

A real livestream of the running world, drawn on the 5-face CC monitor jumbotron
(computer 10, "pokemon"). Built & verified live 2026-07-15.

## Architecture (three pieces, two sidecars + one CC program)

```
┌─ garviscam sidecar ────────────┐   mpegts    ┌─ stadiumcast sidecar ─┐   ws frames   ┌─ computer 10 ─┐
│ headless modded MC client      │ ──tcp────▶  │ sanjuuni -T live      │ ──:8177────▶  │ jumboplay.lua │
│ (fat_balls_addict, spectator   │   :8180     │ encode → CC frames    │  (CC http     │ blits to all  │
│ over the field) under Xvfb;    │             │ (542x414, ~5fps)      │   allow-rule) │ monitor faces │
│ ffmpeg x11grab 10fps           │             │                       │               │       +       │
└────────────────────────────────┘             │ channels.js ctl API   │ ◀──:8178────  │ channel picker│
                                               └───────────────────────┘   http GET    └───────────────┘
                                                  │ tune (fixed argv)
                                                  ▼ source.sh live|bloomberg|youtube <url>|channel <id>
```

- **garviscam** (`apps/server/garviscam/`): portablemc + NeoForge client + the
  pack (minus sodium/iris/entityculling — GPU-perf mods fight llvmpipe), LWJGL
  **linux-arm64** natives from Maven (Mojang only ships x86_64), Xvfb owned by
  the entrypoint, `camloop.sh` supervises client + capture and auto-accepts the
  server resource-pack prompt (xdotool). MSA session lives in the
  `garviscam-data` volume (one-time `portablemc login <email> --auth-no-browser`).
- **stadiumcast** (`apps/server/stadiumcast/`): sanjuuni built from source;
  live loop = listen :8180 for mpegts → serve CC frames on ws :8177. The
  source is switchable since 2026-07-23 (`/opt/source.sh live|bloomberg|youtube
  <url>`, state in `/media/source`, persists across restarts). `bloomberg` swaps
  the camera feed for Bloomberg TV's public HLS stream
  (`bloomberg.com/media-manifest/streams/us.m3u8`, found via iptv-org's
  streams.json like the termtv app; `BLOOMBERG_URL` env overrides) — an
  in-container ffmpeg downsamples it to 10fps/542x414 (the known-good
  sanjuuni load, camloop's codec recipe) and pushes mpegts to sanjuuni over a
  FIFO. `youtube` resolves any link with an in-container yt-dlp (nightly +
  self-update, nodejs for YouTube's n-challenge, optional `/media/cookies.txt`)
  and plays it at **3fps** with ffmpeg `-re -stream_loop -1`; players trigger it
  from Minecraft chat by pasting a link at Garvis. garviscam's :8180 push gets
  connection-refused during both (camloop retries forever — camera client and
  Owncast stream unaffected). Two landmines: sanjuuni `-T` encodes only as the ws
  client REQUESTS frames — no jumboplay connected (stadium chunk unloaded) =
  sanjuuni parked at `frame 0/0` with its input backed up (idle, not broken); and
  the ffmpeg→sanjuuni hop must NOT be a TCP port — a video ending restarts the
  pair within seconds and the old connection's TIME_WAIT blocks the rebind
  ("Connection refused" on a ~60s loop), which is why it's a FIFO.
- **channels.js** (`apps/server/stadiumcast/channels.js`, 2026-07-25): the TV
  catalog + the `:8178` control API the in-game picker tunes through. `source.sh
  channel <id-or-name>` is now a first-class mode next to live/bloomberg/youtube,
  which makes "bloomberg mode" retroactively just one channel out of ~10.5k.
  This is a port of the ONLY part of the owner's termtv app
  (`~/projects/active/tv`) that this stack didn't already have: its data layer
  (`channels.py` + `curated.py` — fetch iptv-org channels.json + streams.json,
  merge, cache 6h, resolve a 19-entry hand-vetted grid out of the long tail).
  termtv's other two layers are already covered here — its render layer
  (`video_widget.py` + the `_octant_ext` C/CUDA sub-cell classifier) is what
  sanjuuni does for CC, and its player layer (`mpv_pty.py`) is what ffmpeg does.
  Nothing was rewritten in Lua. Two things it does that termtv doesn't, because
  the faces are a harsher target than a terminal: it carries each stream's
  `user_agent`/`referrer` into ffmpeg (some CDNs 403 without them) and picks the
  variant nearest 542x414 instead of `streams[0]`. Endpoints: `/channels`
  (curated grid + what's on), `/search?q=`, `/tune?id=|?mode=`, `/now`,
  `/health`, `/refresh`. Two deliberate shapes: the index build runs as a
  SHORT-LIVED child (`node channels.js build`) because parsing the 11MB upstream
  catalog peaks at a few hundred MB and this container is capped at 2g next to
  sanjuuni's frame store; and `/tune` shells into source.sh with fixed argv, so
  the container stays the only thing that touches ffmpeg/ffprobe.
- **jumboplay.lua** (this dir): sanjuuni websocket protocol ("n" is a *rolling*
  head counter in live mode — chase it, jump forward when >2s behind), draws
  every attached monitor, auto-reconnects, `cc_stop`/q to stop. In computer
  10's startup.lua. Since 2026-07-25 it also hosts the **channel picker** as a
  second coroutine under the same `parallel.waitForAny` — the video path is
  unchanged and degrades independently (control API unreachable = the menu says
  so, the faces keep playing). Two surfaces, one list: this computer's terminal
  (arrows + enter, `/` searches the full catalog, `c` = camera, `q` = quit) and
  an optional touch "guide" monitor. Monitors are classified by SIZE — the modal
  size is the video wall, anything else becomes the guide — so placing a small
  monitor on computer 10 (or its wired network) turns it into a tappable channel
  board with no config change; with only the 5 identical faces attached the
  picker is keyboard-only. The terminal is the menu now, so stream health shows
  as a measured-fps badge in the header instead of scrolling prints, and a 5s
  tick re-reads `/now` so a tune from chat or the CLI can't leave it stale.

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
  save — no server restart. It matches by HOST with no port, so the picker's
  `http.get` to `:8178` was already covered by the rule the ws stream uses; the
  control API needed no config change at all.
- The iptv-org long tail is mostly junk — dead, geo-blocked, or audio-only. That
  is WHY the curated grid exists and why `source.sh channel` ffprobe-vets before
  it flips: a channel that fails after the flip has already blanked a screen that
  was playing fine. Verified 2026-07-25 — a refused pick leaves the previous
  channel up and returns the reason to the player. `cartoon network` simply isn't
  in the catalog (no free stream); that's data, not a bug.
- A channel's stream URL is re-resolved AND re-probed on every supervisor loop,
  not cached at tune time: iptv-org lists many variants per channel (25 for
  Bloomberg), they rotate, and `--probe` returns the best-ranked one that plays
  right now — so a variant dying mid-play heals into the next-best instead of
  looping on a corpse. The legacy `bloomberg` mode is kept as its own pinned feed
  so the `BLOOMBERG_URL` override keeps working.
- **A VALID STREAM IS NOT NECESSARILY THE CHANNEL** (cost a debugging round on
  2026-07-25). ffprobe can only answer "is there decodable video here", and an ad
  slate answers yes. Two kinds of impostor sit in the catalog: Pluto TV
  (`jmp2.uk/plu-…`) URLs that serve a "pluto tv" bumper, and broadcaster
  per-event feeds (`*-event.m3u8`) that hold a slate when no event is on. Both
  probe clean. The first symptom is a player reporting "I picked a channel and
  the screen didn't change" — a near-static dark frame on the faces reads exactly
  like a frozen screen. Mitigation is in `rankStreams`, NOT in the probe: labelled
  quality beats unlabelled (the impostors are usually untagged), non-event beats
  event, then nearest 720p, then upstream order. Regression that caused it:
  scoring unlabelled as "neutral ~540" promoted two Pluto URLs above every real
  720p feed and pushed `bloomberg.com/…/us.m3u8` to position 16. Don't treat
  unknown quality as average.
- Editing scripts under `garviscam/scripts/` requires an image rebuild — they
  are COPY'd in (a stale-script launch cost us a silent no-join once).
