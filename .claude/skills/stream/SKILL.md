---
name: stream
description: Put a TV stream (Bloomberg for now) on the Pokémon-stadium jumbotron, flip it back to the live camera, check pipeline health, fix a frozen/blank jumbotron, or change the feed URL. Use for any "put X on the jumbotron / change the channel / stream Bloomberg / back to camera" request. Invoked as /stream <what to do>.
argument-hint: "[bloomberg | live | status | fix the jumbotron]"
allowed-tools: "Read, Bash(docker exec*), Bash(docker compose*), Bash(docker cp*), Bash(docker ps*), Bash(curl*), Bash(apps/server/garvtunnel/cc*), Bash(.claude/skills/cc/scripts/ccdeploy*)"
---

# stream — TV channels on the jumbotron 📡

**Do `$ARGUMENTS`** (repo root; compose dir `apps/server/`). Chain (since 2026-07-23, c9b149c):
public HLS feed → ffmpeg in mc-stadiumcast (10fps/542×414 h264 → mpegts 127.0.0.1:8181) → sanjuuni `-T` → ws://stadiumcast:8177 → `jumboplay.lua` on computer 10 → 5 monitor faces.
Camera mode instead has sanjuuni listen on :8180 for the garviscam push. Full arch: `.claude/skills/cc/examples/jumbotron/README.md`; camera/body ops = `/jumbotron`.

## Switch the channel
- Bloomberg ON: `docker exec mc-stadiumcast /opt/source.sh bloomberg`
- Camera back: `docker exec mc-stadiumcast /opt/source.sh live`
- State file `/media/source` (persists across restarts; no file = live). The entrypoint loop swaps the pipeline within ~5s; jumboplay reconnects on its own — nothing to do on the CC side.

## Status / verify
- Frame counter: `docker exec mc-stadiumcast sh -c 'tr "\r" "\n" < /media/live.log | tail -1'` — ADVANCING = jumboplay is connected and the faces are drawing (~4-5fps effective).
- **`frame 0/0` forever = IDLE, not broken**: sanjuuni `-T` encodes frames only as the ws client REQUESTS them. No jumboplay connected → no encode, and the ffmpeg tcp send-queue backs up harmlessly. It starts the moment jumboplay connects.
- ffmpeg pull log: `/media/bloomberg.log` — "corrupt input packet" / "timestamp discontinuity" lines are normal HLS live-edge noise, not failures.
- Procs: `docker exec mc-stadiumcast sh -c 'pgrep -x sanjuuni; pgrep -x ffmpeg'` (bloomberg mode = both; live mode = sanjuuni only).

## Jumbotron blank/frozen? (escalate in order)
1. **Chunk loaded?** The jumbotron only runs while computer 10's chunk is loaded. Stadium is forceloaded since 2026-07-23 (`forceload add -970 -170 -920 -130`, 11 chunks; check: `docker exec mc-neoforge rcon-cli "forceload query -948 -147"`; revert = `forceload remove` same args).
2. **Computer on?** `docker exec mc-neoforge rcon-cli "computercraft dump"` — LANDMINE: it reports computer 10 at (20481031, 122, 20485130); that's a Sable sub-level coordinate-space artifact, NOT a stolen computer — it's physically at the stadium with its 5 monitors. Boot it remotely: `rcon-cli "computercraft turn-on 10"`.
3. **jumboplay running?** `apps/server/garvtunnel/cc -s` should list id 10. Restart the player: `cc -i 10 'os.queueEvent("cc_stop")'` then `CCDEPLOY_ID=10 ccdeploy .claude/skills/cc/examples/jumbotron/jumboplay.lua /jumboplay.lua jumboplay`.
4. **Whole layer:** `docker compose restart stadiumcast` — resumes whatever `/media/source` says.

## Change the feed / other channels
- Default = Bloomberg's own manifest `https://bloomberg.com/media-manifest/streams/us.m3u8` (iptv-org catalog, channel id `BloombergTV.us` — the same source the owner's ~/projects/active/tv termtv app resolves).
- URL dead? Re-resolve + probe: `curl -s https://iptv-org.github.io/api/streams.json | jq -r '.[] | select(.channel == "BloombergTV.us") | .url'`, then `docker exec mc-stadiumcast ffprobe -v error -show_entries stream=codec_name -i "<url>"` (probing from inside also proves container egress).
- Override: set `BLOOMBERG_URL` on the stadiumcast service in compose, then `docker compose up -d stadiumcast` (recreate applies env). Any HLS URL works; the mode name stays "bloomberg".
- Owner scope (2026-07-23): **only Bloomberg for now** — don't build a channel grid unasked.

## Gotchas
- stadiumcast scripts (`entrypoint.sh`, `source.sh`) are BAKED into the image — rebuild after edits: `docker compose build stadiumcast && docker compose up -d stadiumcast`.
- Video only — there is no audio path to the monitor faces.
- Bloomberg mode needs no camera: garviscam's :8180 push just gets connection-refused and retries forever (harmless; camera + Owncast stream unaffected when running).
- `live` mode shows nothing while garviscam is down. As of 2026-07-23 garviscam is deliberately STOPPED (Secret Base Trainer/Sable StackOverflowError crashes fresh-joining clients; the crash screen was spamming tv.starting.cc) — `docker compose start garviscam` once that bug is fixed. See /jumbotron + minecraft-server-operational-state memory.
