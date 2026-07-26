# jumbotron — live in-game camera on the Pokémon-stadium screens 📺

A real livestream of the running world, drawn on the 4-face CC monitor jumbotron
(computer 10, "pokemon"). Built & verified live 2026-07-15. The wall was rebuilt
2026-07-26 — bottom face removed, the four remaining enlarged to a uniform
271x152 chars at 0.5 textScale, i.e. `CAST_W/H = 542x456`.

## Architecture (three pieces, two sidecars + two CC programs)

```
┌─ garviscam sidecar ────────────┐   mpegts    ┌─ stadiumcast sidecar ─┐   ws frames   ┌─ computer 10 ─┐
│ headless modded MC client      │ ──tcp────▶  │ sanjuuni -T live      │ ──:8177────▶  │ termtv.lua    │
│ (fat_balls_addict, spectator   │   :8180     │ encode → CC frames    │  (CC http     │ blits the SAME│
│ over the field) under Xvfb;    │             │ (542x456, 5fps)       │   allow-rule) │ frame to all 4│
│ ffmpeg x11grab 10fps           │             │                       │               │ faces + remote│
└────────────────────────────────┘             │ channels.js ctl API   │ ◀──:8178────  │ on its terminal│
                                               ├───────────────────────┤   http GET    └───────────────┘
                                               │ castaudio.js          │                ┌─ stadium PA ──┐
                                               │ own ffmpeg → DFPWM    │ ──:8179────▶   │ speakers, on  │
                                               └───────────────────────┘   ws audio     │ SOME computer │
                                                  │ tune (fixed argv)                   │ at the seats  │
                                                  ▼ source.sh live|bloomberg|youtube <url>|channel <id>
                                                                                        └───────────────┘
  … and the same three services again, sized for a small screen (2026-07-25):

  ┌─ stadiumcast, termtv leg ─┐   ws :8182 frames (158x114 = 79x38 chars, 8fps)   ┌─ computer 12 ─┐
  │ own ffmpeg + own sanjuuni │ ────────────────────────────────────────────────▶ │ termtv.lua    │
  │ own castaudio.js          │ ──:8183 ws audio───────────────────────────────▶  │ monitor +     │
  └───────────────────────────┘ ◀─:8178 same ctl API, same /media/source ───────  │ speaker +     │
                                                                                  │ remote on the │
                                                                                  │ terminal      │
                                                                                  └───────────────┘
```

Both legs read the same source but never share a process.

**termtv** is one program for BOTH sets (since 2026-07-25 — it replaced
`jumboplay.lua` on computer 10). The sets differ only in wiring, and the wiring
is auto-detected: EVERY monitor is part of the video wall (four faces at the
stadium, one monitor at a TV) and they all show the same frame; every speaker in
reach is the PA. The only per-set config is which leg of the pipeline to attach
to, two lines in `/tv.conf` on that computer's own disk.

Each set gets its own leg (`cast_loop` in `entrypoint.sh` runs twice, with
different resolution/port/fifo/log), so one viewer can never stall the other.
What IS shared is the tuned channel — `/media/source` is one global "what's on",
so tuning at the TV changes the stadium too. One world, one channel, on purpose.

**Sound comes from a speaker on computer 10 and IS audible at the seats** — owner
confirmed 2026-07-26. Worth stating because the rig is a **Sable moving structure**
(it hangs from a Create rope), so its blocks really sit ~20.5M blocks out in the
overworld while Sable simulates them over the stadium — and this stack spent a
session assuming a speaker out there played to an empty room. Sable's projection
carries sound as well as rendering; see the Sable landmine below for the query that
fooled us. `jumboaudio.lua` remains the option for a speaker-only computer.

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
  in-container ffmpeg downsamples it to 10fps at the wall's `CAST_W`x`CAST_H`
  (542x456, camloop's codec recipe) and pushes mpegts to sanjuuni over a
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
  `user_agent`/`referrer` into ffmpeg (some CDNs 403 without them) and ranks the
  variants (labelled beats unlabelled, then nearest 720p — the cleanest thing to
  downsample to the faces) instead of taking `streams[0]`. Endpoints: `/channels`
  (curated grid + what's on), `/search?q=`, `/tune?id=|?mode=`, `/now`,
  `/health`, `/refresh`. Two deliberate shapes: the index build runs as a
  SHORT-LIVED child (`node channels.js build`) because parsing the 11MB upstream
  catalog peaks at a few hundred MB and this container is capped at 2g next to
  sanjuuni's frame store; and `/tune` shells into source.sh with fixed argv, so
  the container stays the only thing that touches ffmpeg/ffprobe.
- **castaudio.js** (`apps/server/stadiumcast/castaudio.js`, 2026-07-25): TV sound
  for the stadium, as a DFPWM websocket on `:8179`. CC really can play arbitrary
  audio — `speaker.playAudio` takes 48kHz mono signed-8-bit PCM and
  `cc.audio.dfpwm` decodes DFPWM1a at 1 bit/sample, so a whole second is 6000
  bytes and cost ~65ms of computer time to decode (measured on computer 10).
  ffmpeg has had a native `dfpwm` encoder since 5.1, so the chain is just
  `channel AAC → ffmpeg → 6KB/s → ws → speakers`.
  **Why this is a second ffmpeg and not sanjuuni's own audio:** sanjuuni does
  carry audio (`-w` "sends the image/video with audio", `-d` for dfpwm, ws command
  `a<offset>`), but in `-T` mode the encoder advances one video frame per client
  message (`sanjuuni.cpp:1225`) and only appends audio as it walks the input, and
  the `a` handler returns a fixed 1s chunk that is ZERO-PADDED when the ring is
  short (`sanjuuni.cpp:281-289`). At the faces' 3-4fps against a 10fps input most
  chunks would come back as silence. Audio must be paced by wall-clock, not by the
  blit rate — which also rules out a second output on the video ffmpeg, since that
  process blocks on the FIFO *by design*. It does have to be the SAME url though
  (channels.js ranks several variants and they aren't always the same programme),
  so `pull_to_sanjuuni` publishes its choice to `/media/audio-source` and
  castaudio.js follows that file — including truncating it on teardown, so audio
  parks with the video.
- **jumboaudio.lua** (this dir): the stadium PA. Finds every attached speaker,
  pulls 1s chunks, decodes, and feeds each speaker in turn; `playAudio` returning
  false is the clock, so it self-paces to real time. Keys: `m` mute, `-`/`+`
  volume, `[`/`]` A/V sync, `r` rescan, `q` quit. Runs on its OWN computer at the
  stadium (Sable landmine below), so it never competes with the blit loop.
- **termtv.lua** + **termtv-startup.lua** (this dir, 2026-07-25): **the** TV
  program — every set runs this one file. Video, audio and the channel remote are
  three coroutines under one `parallel.waitForAny`; each degrades on its own (a
  dead control API just makes the menu say so, the picture keeps playing). Keys:
  enter tune, `/` search, `c` camera, `m` mute, `-`/`=` volume, `[`/`]` A/V sync,
  `r` reload + rescan speakers, `q` quit.
  Hardware is auto-detected so a set can be built anywhere: EVERY monitor plays
  the video and they all show the SAME frame — the jumbotron is the sides of one
  cube, not a tiled picture — and every speaker in reach is the PA. Screens do NOT
  have to match each other or the feed: each takes the centre of the frame,
  cropping what doesn't fit and letterboxing what falls short (see the sizing
  landmine below). A monitor becomes the tappable touch "guide" only when
  `/tv.conf` names it (`guide=monitor_7`) — auto-detecting that from geometry is
  what broke the wall. (Touch path is **still untested in-world**.)
  The per-set difference is two lines in `/tv.conf` on the computer's own disk
  (`video=`/`audio=` ws urls; also `ctl=`, `scale=`, `guide=`, and `audio=off` to
  hand the sound to another computer). No file = the small-TV leg, so a fresh set
  needs no config. `W`/`H` for that leg in compose must match the monitor at 0.5
  textScale (`cols*2` x `rows*3`, even numbers) or the picture crops/letterboxes —
  termtv says so in its status line and publishes both in `/tv.stat`
  (`feed=271x152 face=271x152` = an exact fit), rather than leaving you guessing.
  It asks for frames ONE round trip each and never polls the head counter (see the
  on-demand landmine below — a poll costs a frame); the header badge shows measured
  fps, and `/tv.stat` is the machine-readable copy.
  `termtv-startup.lua` installs as `/startup.lua` on both sets: garvtunnel client
  in a background tab, termtv in the focused one, because a chunk unload reboots
  the computer.
- **jumboplay.lua** (this dir): SUPERSEDED by termtv.lua on 2026-07-25, kept as
  the rollback (it is still on computer 10's disk — `shell.run("/jumboplay.lua")`
  after a `cc_stop`). Same picker, same protocol, but video only, and it polls the
  head counter before every frame, which costs a whole extra tick-bound round trip
  per frame: it drew the faces at 3-4fps where termtv measures 5.44.

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
- **The faces need not be the same size, so never classify screens by geometry.**
  Before the 2026-07-26 rebuild they were three sizes at 0.5 textScale (271x138 x2,
  228x138 x2, 228x152). jumboplay's picker rewrite (2026-07-25) introduced "the
  modal size is the video wall, anything else is the touch guide" — so the 271x138
  pair won the tiebreak and became the whole wall, one 228x138 became a channel
  board, and the other two fell out of the draw loop entirely. The jumbotron played
  on **two** faces, which looked deliberate enough that it went unnoticed until the
  owner asked why the video wasn't on all five. termtv.lua plays on EVERY monitor
  and only treats one as the guide when `/tv.conf` names it outright. Each screen
  shows the CENTRE of the frame (per-row `sub()` to crop, cursor offset to
  letterbox), so mixed sizes look intentional instead of off-centre. Check it with
  `screens=` in `/tv.stat`, not by eye.
- **A wall rebuild silently renames every peripheral and resizes the picture.**
  The 2026-07-26 rebuild (bottom face removed, the four remaining enlarged) turned
  monitor_5..9 into monitor_12..15 — nothing hard-codes those names, so termtv just
  needed a relaunch (`cc_stop` + `ccdeploy`) to rescan. The frame size does NOT
  follow automatically: `CAST_W/H` stayed at the old modal face (542x414 = 271x138)
  against a 271x152 wall, i.e. a 7-row black band top and bottom on every face. It
  never errors and it looks plausible, so the only way to catch it is `feed=` vs
  `face=` in `/tv.stat`. After any rebuild: read the new sizes, set `CAST_W/H` (or
  `TERMTV_W/H`) to `cols*2` x `rows*3`, `docker compose up -d stadiumcast`.
- **sanjuuni `-T` is driven ENTIRELY by the client, so every extra message costs a
  frame.** The encoder thread encodes one frame and then blocks on a condvar
  (`sanjuuni.cpp:1225`); the websocket handler notifies it once per *received
  message*, whatever the message is (`:266-270`), and only a `v` request sends a
  frame back and frees it (`frameStorage[frame] = ""`, `:277`). Three consequences:
  requesting `v<n>` for a frame the encoder has not reached yet is fine and blocks
  until it exists (measured 100.1ms/frame against a 10fps source); the head counter
  is needed only to pick a starting point, and jumboplay's poll-then-fetch dance
  cost a whole tick-bound round trip per frame (5.6 → 8.9fps on the small TV when
  dropped, 3-4 → ~5fps on the faces); and **a periodic `n` poll can only make
  things worse** — it steps the encoder without taking the frame, so the gap grows
  by exactly one every poll. A 2s "resync" tried on 2026-07-25 reported `behind=65`
  after 66 polls, i.e. ~14s of pure A/V lag bought for no information. The client
  cannot fall behind the encoder on its own; walking forward keeps the gap fixed.
- **Pace the feed just UNDER what the screen can draw, or the picture slides away
  from the sound.** This is the VOD `YT_FPS` rule, and it turns out to apply to
  live channels too. Encode faster than the screen draws and the FIFO backs up,
  ffmpeg blocks, and a LIVE source can never catch up again: the picture walks
  steadily behind the live edge while the audio leg stays on it, so the sound
  drifts progressively AHEAD of the picture. Under the ceiling, the client waits
  on the encoder instead and both hold station. Measured draw rates on 2026-07-25:
  **8.9fps** for the small TV (one 79x38 screen) → `TERMTV_FPS=8`, **~5fps** for
  the faces → `CHANNEL_FPS=4`. The 2026-07-26 rebuild left that alone on purpose:
  four 271x152 faces are 164,768 chars a frame against the old five mixed faces'
  172,380, so the margin only got wider. Don't raise a screen's fps without
  measuring what it actually draws — and measure it from `/tv.stat` on the
  computer, because sanjuuni's own progress counter is the ENCODE rate, which in
  `-T` mode is just the rate the client is asking at. Beware one trap when reading
  `fps=`: it is averaged from the moment the socket opened, so straight after a
  reconnect the client is draining whatever the encoder buffered and reads ~1fps
  HIGH. Only a figure from a settled connection is the real draw rate.
- **sanjuuni's frame store never gives memory back, even for frames it HAS sent.**
  `frameStorage[frame] = ""` (`sanjuuni.cpp:277`) sets the string's length to 0 but
  libstdc++ keeps its capacity, so every frame it ever encodes holds ~365KB (at
  542x414; it scales with the frame) until the process dies — measured 2026-07-25
  as a dead-linear
  ~96MB/min at ~4.4fps, with the client keeping up perfectly and skipping nothing.
  So the RSS climb is NOT "banking frames nobody asked for", and no client-side
  pacing can stop it; the park cycle and the `CAST_MAX_RSS_MB` recycle are the
  only things standing between this and the 94GB host outage of 2026-07-24. A
  1-line upstream fix would be `std::string().swap(frameStorage[frame]);` there —
  we build sanjuuni from source in the Dockerfile, so patching it is cheap and
  would turn the ~10-minute recycle cycle into nothing. **Not done yet.**
- **A TV's chunk unloads when nobody is there, which REBOOTS the computer.** A
  `wget run http://garvtunnel:8176/` bootstrap lives in RAM only, so a computer
  set up that way silently drops off the tunnel the first time its owner walks
  away — and then it can't be reached to fix remotely, which costs a trip
  in-world and a retyped line. Anything placed outside a forceloaded chunk needs
  `/garvtunnel.lua` + `/startup.lua` **on disk** (see `termtv-startup.lua`) before
  you rely on it. Verify with a real `os.reboot()`, not by hoping: the tab list
  coming back as `1:shell, 2:garvtunnel, 3:termtv` with focus 3 is the proof.
- **The jumbotron is a Sable moving structure, so its BLOCK ADDRESS is not where it
  is.** The whole rig — computer 10, the monitor faces, the cables, the speaker —
  physically lives in the plain overworld at ~(20481030, 133, 20485130), ~20.5M
  blocks out; `data get block` there returns ComputerId 10 and a geo-scan at
  radius 4 finds the rest. **Sable** (`sable-neoforge`, "interactive moving block
  structures with physics" by RyanHCode — the library under Create Aeronautics,
  depends on create + flywheel) keeps a structure's blocks in that far region and
  simulates them at the structure's real position; the owner's jumbotron hangs from
  a Create rope, which is why it is a Sable structure at all.
  The projection carries **rendering, interaction AND sound** — a speaker attached
  to computer 10 is heard at the seats (owner confirmed 2026-07-26). What it does
  NOT carry is raw block-position queries, and that trap cost a session: computer
  10's own player detector reports **0 players within 64** no matter who is at the
  stadium, because it is querying the empty region 20M blocks away. Reading that as
  "so the speaker plays to nobody" was wrong — a detector on the structure can
  never see a stadium visitor, so it is not evidence about audio either way. Two
  live consequences: `computercraft dump` shows the structure-space address (don't
  read it as "the computer is lost"), and re-assembling the structure re-creates
  those blocks, which **renames every peripheral and reboots the computer** — see
  the rebuild landmine above. (Speaker range still follows normal MC falloff scaled
  by volume, max 3.0, so several quiet speakers beat one loud one; `jumboaudio.lua`
  + `audio=off` in `/tv.conf` puts them on their own computer if you want that.)
- **`speaker.stop()` cancels the very event a `playAudio` retry is waiting for, so
  muting wedged the sound until a restart.** The streaming pattern (from sanjuuni's
  own generated player, and it IS the right clock) is: push a chunk, and while
  `playAudio` returns false wait for that speaker's `speaker_audio_empty`. But that
  event fires when the queued audio is handed off — and `stop()` throws the queue
  away, so nothing is handed off and the event never comes. termtv's `m` key calls
  `stop()` on every speaker, and the audio coroutine spends nearly all its time in
  that wait, so muting almost always parked the coroutine *permanently*: mute
  worked, then unmute set `state.muted = false` with nothing left running to read
  it (found 2026-07-26; the identical bug was in `jumboaudio.lua`). Two lessons.
  **(1)** Any wait for a peripheral event another coroutine can invalidate needs a
  timer escape and a re-check of the state it's waiting on — `playAll` now wakes
  every 0.5s, returns immediately when muted or stopped, and after 6s with no drain
  event at all treats the buffer as stuck (`stop()` + drop the chunk, counted as
  `spk-stall`). **(2)** The in-game symptom (silence) is indistinguishable from a
  dead feed, but the container tells them apart for free: `castaudio`'s `/health`
  showing **`served` frozen while `clients` is still 1** and `queued` climbing to
  `RING_MAX` means the socket is up and the CC side has stopped asking — a parked
  client, not a broken pipeline. `docker exec mc-stadiumcast curl -s
  localhost:8179/health` twice, ten seconds apart, is the whole diagnosis: `served`
  climbing by ~1/s is a healthy set. To reproduce the failure mode
  without touching a key: `cc -i 10 'peripheral.call("right","stop")'` a few times
  and watch whether `served` keeps climbing.
- **CC does not reap a program's websockets when the program exits.** Verified on
  :8179: kill jumboaudio with `cc_stop` and its connection stays ESTABLISHED.
  `max_websockets = 4` per computer, so four stop/start cycles lock that computer
  out of the feed until it reboots. Any long-running ws program must close the
  handle *after* `parallel.waitForAny` returns — the coroutine's own cleanup never
  runs, because waitForAny returns the instant the other coroutine ends.
- **Don't pace a live audio buffer off instantaneous queue depth.** HLS hands over
  a whole segment at once: measured 6 chunks every 6s, averaging exactly real time.
  The first cut of castaudio.js trimmed the ring to the target on every serve,
  which discarded whole bursts — 8 chunks and 4 silences out of 12 requests, with
  88% of produced audio thrown away. The buffer has to be deeper than the segment
  period (hence `CAST_AUDIO_DELAY` default 8), and trimming may only happen when
  depth exceeds target + a full burst of slack.
- ffmpeg gulps the entire HLS playlist window at startup (no `-re` on a live
  source, deliberately — that gulp is what puts it near the live edge). So the
  first chunks in the ring are tens of seconds stale; castaudio.js re-anchors to
  the newest `target` chunks instead. Don't "fix" it by adding `-re` to a live
  pull: that paces reading at 1x from the *start* of the window and pins you
  permanently a window-length behind live.
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
