---
name: stream
description: Put a YouTube video or any of ~10.5k iptv-org TV channels on the Pokémon-stadium jumbotron, flip it back to the live camera, work on the in-game channel picker or the curated grid, check pipeline health, fix a frozen/blank jumbotron, or change a feed URL. Use for any "play this link on the jumbotron / put X on the big screen / change the channel / what channels can we get / back to camera" request. Invoked as /stream <what to do>.
argument-hint: "[<youtube url> | <channel name> | bloomberg | live | status | fix the jumbotron]"
allowed-tools: "Read, Bash(docker exec*), Bash(docker compose*), Bash(docker cp*), Bash(docker ps*), Bash(docker logs*), Bash(curl*), Bash(systemctl --user*), Bash(journalctl --user*), Bash(apps/server/garvtunnel/cc*), Bash(.claude/skills/cc/scripts/ccdeploy*)"
---

# stream — TV channels + YouTube on the jumbotron 📡

**Do `$ARGUMENTS`** (repo root; compose dir `apps/server/`). Chain (since 2026-07-23, c9b149c):
feed → ffmpeg in mc-stadiumcast (10fps live / 3fps VOD, 542×414 h264 → mpegts over a FIFO) → sanjuuni `-T` → ws://stadiumcast:8177 → `jumboplay.lua` on computer 10 → 5 monitor faces.
Camera mode instead has sanjuuni listen on :8180 for the garviscam push. Full arch: `.claude/skills/cc/examples/jumbotron/README.md`; camera/body ops = `/jumbotron`.

## Switch the channel
- YouTube: `docker exec mc-stadiumcast /opt/source.sh youtube "<url>"` — resolves the link with yt-dlp FIRST and exits non-zero (leaving the current channel alone) if it won't play; prints `source -> youtube ▶ <title>`. Any yt-dlp-supported site works from the CLI, not just YouTube. A finished video loops.
- **Any TV channel** (~10.5k, iptv-org): `docker exec mc-stadiumcast /opt/source.sh channel "sky news"` — takes a channel id or a name, resolves it against the catalog, ffprobe-vets the stream, and only then flips; prints `source -> channel ▶ <label>`. A dead/geo-blocked pick exits non-zero with the reason and **leaves the current channel playing**.
- Bloomberg: `docker exec mc-stadiumcast /opt/source.sh bloomberg` (its own pinned feed + `BLOOMBERG_URL` override; `channel bloomberg` goes through the catalog instead)
- Camera back: `docker exec mc-stadiumcast /opt/source.sh live`
- State file `/media/source` (`<mode>[ <url>]`, persists across restarts; no file = live) + `/media/now-playing` (title). The entrypoint loop swaps the pipeline within ~5s; jumboplay reconnects on its own — nothing to do on the CC side.

## The in-game channel picker (computer 10, since 2026-07-25)
`jumboplay.lua` runs the picker next to the video loop. **On the computer's terminal:** ↑↓/PgUp/PgDn, `enter` tunes, `/` searches the whole catalog, `esc` back to the curated grid, `c` = camera, `r` = reload, `q` = quit. Header shows what's on + the measured face draw-rate; a 5s tick re-reads `/now`, so a tune from chat or the CLI shows up there too.
**Touch guide (optional):** monitors are classified by SIZE — the modal size is the video wall, anything else becomes a tappable channel board. Place a small monitor on computer 10 or its wired network and it lights up as the guide with no config change (tap a row to tune, bottom row = camera, top rows = reload); set `GUIDE` at the top of jumboplay.lua to force a specific one. With only the 5 identical faces attached the picker is keyboard-only. **Touch path is untested in-world as of 2026-07-25 — no spare monitor exists yet.**
Catalog/control API = `channels.js` in mc-stadiumcast on `:8178` (internal only): `/channels` `/search?q=` `/tune?id=|?mode=live` `/now` `/health` `/refresh`. Check it: `docker exec mc-stadiumcast curl -s localhost:8178/health`. Drive the picker remotely (this is how it was verified): `apps/server/garvtunnel/cc -i 10 'os.queueEvent("key", keys.down, false)'` then the same with `keys.enter`.

## Players do it themselves, in-game
Anyone can paste a link at Garvis in Minecraft chat: `!g put https://youtu.be/… on the jumbotron` (the bare link works too). Also `!g put sky news on the jumbotron` / **any channel name** — `!g switch the jumbotron to cnbc asia`, `!g jumbotron: cgtn` — plus `!g bloomberg on the jumbotron` / `!g put the camera back on the jumbotron`.
The name is peeled out of the sentence by regex in `parseChannelAsk` (no classifier call), sanitised, and handed to `source.sh channel` as fixed argv; the catalog does the fuzzy matching. Pronouns are refused deliberately ("put *that* on the jumbotron" → null, so it falls through to the normal intents). A name that matches nothing comes back to the player as `No luck with "<x>" — no channel matching "<x>"` and changes nothing.
Path: `apps/garvis-bot/src/jumbotron.js` — a deterministic fast path in `onInGameMessage` (NO classifier call, checked before every other intent), which normalises the link to a canonical watch URL from a validated 11-char video id and fixed-argv `docker exec`s source.sh. Kill switch `GARVIS_INGAME_JUMBOTRON=off` in `apps/garvis-bot/.env` + `systemctl --user restart garvis-bot`.
Deliberately NOT wired into the paid stream-chat path (`streamchat.js`) — tollbooth buyers get body+TV only.

## Status / verify
- Frame counter: `docker exec mc-stadiumcast sh -c 'tr "\r" "\n" < /media/live.log | tail -1'` — ADVANCING = jumboplay is connected and the faces are drawing (~3-4fps).
- **Nobody watching = 0 procs, and that is HEALTHY.** Since the 2026-07-24 leak fix the pipeline duty-cycles: up ~30s to offer a connection, and if no ws client attaches it tears down and parks 45s (an unwatched `-T` sanjuuni frees nothing and grew to 94 GiB RSS, taking the host down). So with an empty stadium the normal signature is BOTH procs absent, `[cast] no viewer after 30s — parking the feed` repeating in live.log, and the pull log ending in `Broken pipe` / `Error writing trailer` — that is the last probe window's teardown, not a crash. **Don't escalate on it.** The feed lights up within ~45s of a player looking at the screen (jumboplay retries every 3s).
- Viewer state: `docker exec mc-stadiumcast sh -c 'tr "\r" "\n" < /media/live.log | grep "\[cast\]" | tail -5'` — `no viewer`/`viewer left` = parked; silence + an advancing frame counter = someone is watching.
- What's up: `docker exec mc-stadiumcast sh -c 'cat /media/source; cat /media/now-playing'`.
- Pull logs: `/media/youtube.log` (yt-dlp + ffmpeg) · `/media/bloomberg.log`. "corrupt input packet" / "timestamp discontinuity" on a live feed is normal live-edge noise, not failure.
- Procs: `docker exec mc-stadiumcast sh -c 'pgrep -x sanjuuni; pgrep -x ffmpeg'` — with a viewer attached, pulled modes = both, live mode = sanjuuni only; with no viewer, neither (see above).

## Jumbotron blank/frozen? (escalate in order)
0. **Is anyone actually watching?** If the report is "it looks dead" from the CLI rather than from a player standing at the screen, stop — see the duty-cycle bullet above. Parked ≠ broken.
1. **Chunk loaded?** The jumbotron only runs while computer 10's chunk is loaded. Stadium is forceloaded since 2026-07-23 (`forceload add -970 -170 -920 -130`, 11 chunks; check: `docker exec mc-neoforge rcon-cli "forceload query -948 -147"`; revert = `forceload remove` same args).
2. **Computer on?** `docker exec mc-neoforge rcon-cli "computercraft dump"` — LANDMINE: it reports computer 10 at (20481031, 122, 20485130); that's a Sable sub-level coordinate-space artifact, NOT a stolen computer — it's physically at the stadium with its 5 monitors. Boot it remotely: `rcon-cli "computercraft turn-on 10"`.
3. **jumboplay running?** `apps/server/garvtunnel/cc -s` should list id 10. Restart the player: `cc -i 10 'os.queueEvent("cc_stop")'` then `CCDEPLOY_ID=10 ccdeploy .claude/skills/cc/examples/jumbotron/jumboplay.lua /jumboplay.lua jumboplay`.
4. **Whole layer:** `docker compose restart stadiumcast` — resumes whatever `/media/source` says.

## A link won't play
- The error the player/CLI sees is yt-dlp's own last line. `Video unavailable` / `Private video` / age-gated → nothing to fix, try another link.
- **`Sign in to confirm you're not a bot`** = YouTube's IP bot-check tripped. Fix: export a Netscape cookies jar from a logged-in browser to `apps/server/stadiumcast/media/cookies.txt` (bind-mounted, gitignored) — `ytdlp-args.sh` picks it up automatically, no rebuild.
- Widespread breakage = stale yt-dlp. It self-updates once on a failed resolve; force it with `docker exec mc-stadiumcast yt-dlp --update-to nightly`.
- The container needs egress: `docker exec mc-stadiumcast yt-dlp --version` then a probe, e.g. `docker exec mc-stadiumcast ffprobe -v error -show_entries stream=codec_name -i "<url>"`.

## Change the feed / the catalog
- Bloomberg's pinned default = `https://bloomberg.com/media-manifest/streams/us.m3u8` (iptv-org, channel id `BloombergTV.us` — the same source the owner's ~/projects/active/tv termtv app resolves).
- URL dead? Re-resolve: `curl -s https://iptv-org.github.io/api/streams.json | jq -r '.[] | select(.channel == "BloombergTV.us") | .url'`; override with `BLOOMBERG_URL` on the stadiumcast service in compose + `docker compose up -d stadiumcast` (recreate applies env).
- **Catalog** (`channels.js`, 2026-07-25): iptv-org channels.json + streams.json merged into `/media/channels.json`, rebuilt on demand every 6h. Force it: `docker exec mc-stadiumcast curl -s localhost:8178/refresh` or `docker exec mc-stadiumcast node /opt/channels.js build --force`. Log: `/media/channels.log` (`index built: 10543 channels, 19/19 curated resolved`).
- **The curated grid is a hand-vetted 19-entry table** ported from termtv's `curated.py` — edit `CURATED` at the top of `apps/server/stadiumcast/channels.js` (label + keywords that must ALL appear in the channel name + country tiebreak + `avoid` words), then rebuild the image. Entries that resolve to nothing are silently dropped, so `19/19` in the log is the health signal.
- Ask the catalog things directly: `docker exec mc-stadiumcast node /opt/channels.js search "al jazeera"` · `resolve "sky news"` (→ `id<TAB>label`) · `url <id>` (→ `url<TAB>ua<TAB>referrer`).
- Scope note: the owner asked for the picker + curated grid + search on 2026-07-25, which supersedes the old "don't build a channel grid unasked" line here. Still unbuilt and still don't add unasked: an EPG/schedule, a playlist queue, or paid channel access from the tollbooth.

## Gotchas
- stadiumcast scripts (`entrypoint.sh`, `source.sh`, `ytdlp-args.sh`, `channels.js`) are BAKED into the image — rebuild after edits: `docker compose build stadiumcast && docker compose up -d stadiumcast`.
- The catalog index build is a SHORT-LIVED child process on purpose: the upstream JSON is ~15MB and parsing it peaks at a few hundred MB, and this container is capped at `mem_limit: 2g` shared with sanjuuni's frame store (which killed the host once). Don't "optimise" it into the long-running serve process.
- Channel URLs are re-resolved AND re-probed every supervisor loop (`channels.js url <id> --probe` — top 3 ranked variants probed concurrently, best one that answers wins, ~5s). A variant dying mid-play heals into the next-best on its own.
- **"I picked a channel and the screen didn't change" = probably an ad slate, not a frozen jumbotron.** ffprobe only proves there's decodable video; a Pluto TV bumper (`jmp2.uk/plu-…`) or an idle per-event feed (`*-event.m3u8`) passes and renders as a near-static dark frame that looks exactly like a freeze. Diagnose by grabbing the actual frame: `docker exec mc-stadiumcast sh -c 'URL=$(node /opt/channels.js url <id> | cut -f1); ffmpeg -y -i "$URL" -frames:v 1 /media/peek.png'` then `docker cp mc-stadiumcast:/media/peek.png /tmp/peek.png` and look at it. Fix belongs in `rankStreams` (labelled quality beats unlabelled, non-event beats event, then nearest 720p, then upstream order) — not in the probe, which cannot tell content from slate.
- Some CDNs 403 without the stream's own `user_agent`/`referrer`; those are carried from the catalog into ffmpeg as input options. termtv drops them, which is why a few channels work here that don't there.
- Video only — there is no audio path to the monitor faces. A music video is a silent music video.
- **Pacing**: the faces really draw 3-4fps (5 monitors × 164×81 blit/frame, server-tick bound). A live feed self-corrects when the encoder outruns that (the HLS demuxer skips to the live edge); a VOD can't, so encoding above the draw ceiling turns into slow motion via backpressure. Hence `YT_FPS=3` + ffmpeg `-re` for pulled files — encode just UNDER the ceiling and let `-re` be the clock. Override per-service with `YT_FPS`/`YT_FORMAT` env.
- The ffmpeg→sanjuuni hop is a FIFO (`/tmp/cast.ts`), not a socket, because restarting a TCP hop within ~60s died on TIME_WAIT ("Connection refused" every time a VOD ended). Don't "simplify" it back to a port.
- googlevideo URLs expire (~6h) — ffmpeg exits, the supervisor re-resolves. Expect a few seconds of black on a long-running video.
- Bloomberg/YouTube modes need no camera: garviscam's :8180 push just gets connection-refused and retries forever (harmless).
- `live` mode shows nothing while garviscam is down. As of 2026-07-23 garviscam is deliberately STOPPED (Secret Base Trainer/Sable StackOverflowError crashes fresh-joining clients; the crash screen was spamming tv.starting.cc) — `docker compose start garviscam` once that bug is fixed. See /jumbotron + minecraft-server-operational-state memory.
