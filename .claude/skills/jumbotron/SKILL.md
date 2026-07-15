---
name: jumbotron
description: Operate the Pokémon-stadium jumbotron live camera and the Garvis player body — move/frame the camera, screenshot its view, make Garvis play (Baritone follow/goto, in-game chat), check health, restart pipeline layers, stream clips to the faces. Use for any jumbotron/stadium-camera/GarvisCam/Garvis-plays request. Invoked as /jumbotron <what to do>.
argument-hint: "[what to do, e.g. \"move the camera over the entrance\"]"
allowed-tools: "Read, Bash(docker exec*), Bash(docker compose*), Bash(docker cp*), Bash(docker ps*), Bash(apps/server/garvtunnel/cc*), Bash(.claude/skills/cc/scripts/ccdeploy*)"
---

# jumbotron — stadium live-camera ops

**Do `$ARGUMENTS`** on the jumbotron stack (repo root; compose dir `apps/server/`). The chain:
`garviscam` (headless modded client, camera acct **fat_balls_addict**, Xvfb :99) → ffmpeg mpegts :8180 → `stadiumcast` (sanjuuni live) → ws :8177 → `jumboplay.lua` on computer 10 → 5 faces.
Architecture + hard-won landmines: `.claude/skills/cc/examples/jumbotron/README.md`.

## Camera (RCON, instant; iterate shot → snap → adjust)
- Move: `docker exec mc-neoforge rcon-cli "tp fat_balls_addict <x> <y> <z> <yaw> <pitch>"` — field ≈ (-948, 85, -147); parked shot: `-943 118 -152 -20 65`.
- See what it sees: `docker exec mc-garviscam /opt/garviscam/snap.sh && docker cp mc-garviscam:/data/snap.png <scratchpad>/snap.png` → Read the png.
- Night vision (re-apply after account resets): `docker exec mc-neoforge rcon-cli "effect give fat_balls_addict minecraft:night_vision infinite 0 true"`

## Garvis plays (Baritone legs — same account, same client)
- Players command him directly in-game: `!g come here` / `follow me` / `stay` / `go to <x y z>` (body intent in apps/garvis-bot — see src/body.js; kill switch GARVIS_INGAME_BODY=off).
- Ops path — type into the client's chat: `docker exec mc-garviscam /opt/garviscam/chat.sh '<line>'` — plain text = public chat; `#...` = Baritone command (intercepted client-side; replies in `/data/work/logs/latest.log` `[CHAT]` lines). Serialized via flock — never bypass chat.sh with raw xdotool typing (interleaved keystrokes corrupt the line and leak keys in-world).
- Play: `docker exec mc-neoforge rcon-cli "gamemode survival fat_balls_addict"` then `chat.sh '#follow player <name>'` · `'#goto <x> <y> <z>'` · `'#stop'`. The jumbotron streams his first-person POV while he plays. `#follow` only binds targets within entity-tracking range (~60 blocks) — tp him close first.
- Back to camera: `chat.sh '#stop'` → `rcon-cli "gamemode spectator fat_balls_addict"` → tp to the parked shot.
- Guardrails persisted in `/data/work/baritone/settings.txt`: allowBreak + allowPlace **false** (never paths through builds) — leave them unless the owner asks.
- Deaths + disconnects self-heal: camloop's respawn_watcher clicks Respawn on death (trigger: Baritone's "Death position saved." log line) and relaunches the client on any server-side drop (trigger: "Client disconnected with reason:" — kicks, netty errors, server stops). Fallback if wedged anyway: `docker exec mc-garviscam sh -c 'pkill -x java'` — rejoining auto-respawns him. Baritone forgets its task on relaunch — re-issue `#follow`/`#goto` after any self-heal.

## Health & restarts (stack self-heals; escalate in order)
- Status: `docker exec mc-neoforge rcon-cli list` (has fat_balls_addict?) · `pgrep -x java`/`ffmpeg` in mc-garviscam · `pgrep -x sanjuuni` in mc-stadiumcast · faces drawing = monitor palette ≠ native (`cc -i 10`).
- Logs: garviscam `/data/client.log`, `/data/capture.log`, `/data/work/logs/latest.log`; stadiumcast `/media/live.log`.
- Client stuck: `docker exec mc-garviscam sh -c 'pkill -x java'` — camloop relaunches + re-accepts the resource-pack prompt.
- Whole layer: `docker compose restart garviscam` / `stadiumcast` (from `apps/server/`).
- CC player: `apps/server/garvtunnel/cc -i 10 'os.queueEvent("cc_stop")'` then `CCDEPLOY_ID=10 ccdeploy .claude/skills/cc/examples/jumbotron/jumboplay.lua /jumboplay.lua jumboplay`.

## Non-live content (clips on the faces)
Drop file in `apps/server/stadiumcast/media/`, then in mc-stadiumcast: `pkill -x sanjuuni`, `docker exec -d mc-stadiumcast sh -c 'sanjuuni -i /media/<file> -w 8177 -W 542 -H 414 > /media/clip.log 2>&1'` — jumboplay reconnects by itself. `docker compose restart stadiumcast` returns to live mode.

## Gotchas
- `garviscam/scripts/*` are baked into the image — **rebuild after edits** (`docker compose build garviscam && docker compose up -d garviscam`).
- Server restarts can silently break the camera two ways (`Incompatible client! Please use NeoForge X` / `not white-listed` in logs): itzg auto-floats the NeoForge build (`VERSION: "1.21.1"`) — chase it by bumping `NEO_VERSION` in `garviscam/scripts/install.sh` + `NEO_ID` in `launch.sh`, rebuild, `docker exec mc-garviscam /opt/garviscam/install.sh`, `pkill -x java`; and `OVERRIDE_WHITELIST=TRUE` rewrites whitelist.json from `MC_WHITELIST` in `apps/server/.env` each start — keep fat_balls_addict in that env line, RCON-only adds get wiped. A refused *login* logs no vanilla disconnect line, so the self-heal watcher can't see it — the client parks on the Failed to connect / multiplayer screen until you `pkill -x java` (after fixing the cause).
- sanjuuni `-T` live mode = one ws client; "n" is a rolling head counter, not a total.
- Pack updated? Resync camera mods: `docker exec mc-garviscam /opt/garviscam/install.sh` (auto-prunes sodium/iris/entityculling).
- MSA relogin (rare, user-interactive): `! docker exec -it mc-garviscam portablemc --main-dir /data/main --work-dir /data/work login <email> --auth-no-browser`.
