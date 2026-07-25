---
name: stream
description: Put a YouTube video or a TV channel (Bloomberg) on the Pokémon-stadium jumbotron, flip it back to the live camera, check pipeline health, fix a frozen/blank jumbotron, or change a feed URL. Use for any "play this link on the jumbotron / put X on the big screen / change the channel / back to camera" request. Invoked as /stream <what to do>.
argument-hint: "[<youtube url> | bloomberg | live | status | fix the jumbotron]"
allowed-tools: "Read, Bash(docker exec*), Bash(docker compose*), Bash(docker cp*), Bash(docker ps*), Bash(docker logs*), Bash(curl*), Bash(systemctl --user*), Bash(journalctl --user*), Bash(apps/server/garvtunnel/cc*), Bash(.claude/skills/cc/scripts/ccdeploy*)"
---

# stream — TV channels + YouTube on the jumbotron 📡

**Do `$ARGUMENTS`** (repo root; compose dir `apps/server/`). Chain (since 2026-07-23, c9b149c):
feed → ffmpeg in mc-stadiumcast (10fps live / 3fps VOD, 542×414 h264 → mpegts over a FIFO) → sanjuuni `-T` → ws://stadiumcast:8177 → `jumboplay.lua` on computer 10 → 5 monitor faces.
Camera mode instead has sanjuuni listen on :8180 for the garviscam push. Full arch: `.claude/skills/cc/examples/jumbotron/README.md`; camera/body ops = `/jumbotron`.

## Switch the channel
- YouTube: `docker exec mc-stadiumcast /opt/source.sh youtube "<url>"` — resolves the link with yt-dlp FIRST and exits non-zero (leaving the current channel alone) if it won't play; prints `source -> youtube ▶ <title>`. Any yt-dlp-supported site works from the CLI, not just YouTube. A finished video loops.
- Bloomberg: `docker exec mc-stadiumcast /opt/source.sh bloomberg`
- Camera back: `docker exec mc-stadiumcast /opt/source.sh live`
- State file `/media/source` (`<mode>[ <url>]`, persists across restarts; no file = live) + `/media/now-playing` (title). The entrypoint loop swaps the pipeline within ~5s; jumboplay reconnects on its own — nothing to do on the CC side.

## Players do it themselves, in-game
Anyone can paste a link at Garvis in Minecraft chat: `!g put https://youtu.be/… on the jumbotron` (the bare link works too). Also `!g bloomberg on the jumbotron` / `!g put the camera back on the jumbotron`.
Path: `apps/garvis-bot/src/jumbotron.js` — a deterministic fast path in `onInGameMessage` (NO classifier call, checked before every other intent), which normalises the link to a canonical watch URL from a validated 11-char video id and fixed-argv `docker exec`s source.sh. Kill switch `GARVIS_INGAME_JUMBOTRON=off` in `apps/garvis-bot/.env` + `systemctl --user restart garvis-bot`.
Deliberately NOT wired into the paid stream-chat path (`streamchat.js`) — tollbooth buyers get body+TV only.

## Status / verify
- Frame counter: `docker exec mc-stadiumcast sh -c 'tr "\r" "\n" < /media/live.log | tail -1'` — ADVANCING = jumboplay is connected and the faces are drawing (~3-4fps).
- **`frame 0/0` forever = IDLE, not broken**: sanjuuni `-T` encodes frames only as the ws client REQUESTS them. No jumboplay connected → no encode, and the writer backs up harmlessly. It starts the moment jumboplay connects.
- What's up: `docker exec mc-stadiumcast sh -c 'cat /media/source; cat /media/now-playing'`.
- Pull logs: `/media/youtube.log` (yt-dlp + ffmpeg) · `/media/bloomberg.log`. "corrupt input packet" / "timestamp discontinuity" on a live feed is normal live-edge noise, not failure.
- Procs: `docker exec mc-stadiumcast sh -c 'pgrep -x sanjuuni; pgrep -x ffmpeg'` (pulled modes = both; live mode = sanjuuni only).

## Jumbotron blank/frozen? (escalate in order)
1. **Chunk loaded?** The jumbotron only runs while computer 10's chunk is loaded. Stadium is forceloaded since 2026-07-23 (`forceload add -970 -170 -920 -130`, 11 chunks; check: `docker exec mc-neoforge rcon-cli "forceload query -948 -147"`; revert = `forceload remove` same args).
2. **Computer on?** `docker exec mc-neoforge rcon-cli "computercraft dump"` — LANDMINE: it reports computer 10 at (20481031, 122, 20485130); that's a Sable sub-level coordinate-space artifact, NOT a stolen computer — it's physically at the stadium with its 5 monitors. Boot it remotely: `rcon-cli "computercraft turn-on 10"`.
3. **jumboplay running?** `apps/server/garvtunnel/cc -s` should list id 10. Restart the player: `cc -i 10 'os.queueEvent("cc_stop")'` then `CCDEPLOY_ID=10 ccdeploy .claude/skills/cc/examples/jumbotron/jumboplay.lua /jumboplay.lua jumboplay`.
4. **Whole layer:** `docker compose restart stadiumcast` — resumes whatever `/media/source` says.

## A link won't play
- The error the player/CLI sees is yt-dlp's own last line. `Video unavailable` / `Private video` / age-gated → nothing to fix, try another link.
- **`Sign in to confirm you're not a bot`** = YouTube's IP bot-check tripped. Fix: export a Netscape cookies jar from a logged-in browser to `apps/server/stadiumcast/media/cookies.txt` (bind-mounted, gitignored) — `ytdlp-args.sh` picks it up automatically, no rebuild.
- Widespread breakage = stale yt-dlp. It self-updates once on a failed resolve; force it with `docker exec mc-stadiumcast yt-dlp --update-to nightly`.
- The container needs egress: `docker exec mc-stadiumcast yt-dlp --version` then a probe, e.g. `docker exec mc-stadiumcast ffprobe -v error -show_entries stream=codec_name -i "<url>"`.

## Change the feed / other channels
- Bloomberg default = `https://bloomberg.com/media-manifest/streams/us.m3u8` (iptv-org catalog, channel id `BloombergTV.us` — the same source the owner's ~/projects/active/tv termtv app resolves).
- URL dead? Re-resolve: `curl -s https://iptv-org.github.io/api/streams.json | jq -r '.[] | select(.channel == "BloombergTV.us") | .url'`; override with `BLOOMBERG_URL` on the stadiumcast service in compose + `docker compose up -d stadiumcast` (recreate applies env).
- Owner scope: Bloomberg + any link players paste. **Don't build a channel grid / EPG / playlist queue unasked.**

## Gotchas
- stadiumcast scripts (`entrypoint.sh`, `source.sh`, `ytdlp-args.sh`) are BAKED into the image — rebuild after edits: `docker compose build stadiumcast && docker compose up -d stadiumcast`.
- Video only — there is no audio path to the monitor faces. A music video is a silent music video.
- **Pacing**: the faces really draw 3-4fps (5 monitors × 164×81 blit/frame, server-tick bound). A live feed self-corrects when the encoder outruns that (the HLS demuxer skips to the live edge); a VOD can't, so encoding above the draw ceiling turns into slow motion via backpressure. Hence `YT_FPS=3` + ffmpeg `-re` for pulled files — encode just UNDER the ceiling and let `-re` be the clock. Override per-service with `YT_FPS`/`YT_FORMAT` env.
- The ffmpeg→sanjuuni hop is a FIFO (`/tmp/cast.ts`), not a socket, because restarting a TCP hop within ~60s died on TIME_WAIT ("Connection refused" every time a VOD ended). Don't "simplify" it back to a port.
- googlevideo URLs expire (~6h) — ffmpeg exits, the supervisor re-resolves. Expect a few seconds of black on a long-running video.
- Bloomberg/YouTube modes need no camera: garviscam's :8180 push just gets connection-refused and retries forever (harmless).
- `live` mode shows nothing while garviscam is down. As of 2026-07-23 garviscam is deliberately STOPPED (Secret Base Trainer/Sable StackOverflowError crashes fresh-joining clients; the crash screen was spamming tv.starting.cc) — `docker compose start garviscam` once that bug is fixed. See /jumbotron + minecraft-server-operational-state memory.
