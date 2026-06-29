# Talking to Garvis in-game

Goal: let players have a conversation with Garvis **without leaving Minecraft**.
Today this is the **`!g` chat trigger** (Phase 1, shipped). A real **`/g` slash
command** backed by a small NeoForge mod is the planned **Phase 2** (jotted down
below so we can build it when there's time).

Both phases reuse the **same Garvis brain** that already answers Discord
@mentions — the bot process (`apps/garvis-bot`) that spawns `claude -p`. The only
difference is the transport that carries the player's message in and Garvis's
reply back out.

---

## Phase 1 — `!g` chat trigger (SHIPPED)

### What it does

A player types in normal chat:

```
<Steve> !g how do waystones work?
[Garvis] Right-click a waystone to activate it, then open any waystone to
         teleport to the ones you've found. ...
```

- **Q&A / conversation only.** Garvis answers questions, explains mods, gives
  advice, and remembers the conversation per player. It does **not** op/ban/give
  or change the repo from in-game (that stays on Discord) — by design, to keep v1
  simple and low-risk.
- Works on a **vanilla NeoForge client** — no client mod, no install. Anyone
  already whitelisted onto the server can use it.

### How it works (no custom mod)

```
player types `!g …` in chat
  → itzg server logs the line:  <Steve> !g how do waystones work?
  → bot tails `docker logs -f --since 1s <MC_CONTAINER>`   (ingame.js)
  → parseChatLine() extracts { player, message } for trigger-matching lines
  → onInGameMessage() (index.js): per-player cooldown, "…thinking" ack
  → answerInGame() runs the read-only Q&A brain (runClaudeResilient, fenced data)
  → reply pushed back in-game via `rcon-cli tellraw @a {json}`  (moderation.js rconExec)
```

This deliberately reuses the **exact trust boundary the bot already owns**: it
already shells out to `docker exec <container> rcon-cli …` (no shell — `execFile`
with an argv array) for `/whitelist` and live moderation. The in-game bridge adds
**no new privileged path** — the only live-server write it makes is a fixed
`tellraw`, and it reuses the existing `rconExec()`.

### Files

| File | Role |
|---|---|
| `apps/garvis-bot/src/ingame.js` | The bridge: tail the log, `parseChatLine()`, chunk + send `tellraw`, reattach on server restart. Pure MC transport — no model, no sessions. |
| `apps/garvis-bot/src/index.js` | Wiring: `buildInGamePrompt()`, `answerInGame()` (per-player session), `onInGameMessage()` (cooldown + ack), and `startInGameBridge({…})` at boot. |
| `apps/garvis-bot/src/moderation.js` | `rconExec()` (already exported) — reused to send `tellraw`. |
| `apps/garvis-bot/src/db.js` | Session store, reused with the key `mc:<player>` (collides with nothing — thread ids are numeric snowflakes). |

### Config (`apps/garvis-bot/.env`)

| Var | Default | Meaning |
|---|---|---|
| `GARVIS_INGAME` | `on` | Kill switch (`on` \| `off`). |
| `GARVIS_INGAME_TRIGGER` | `!g` | Chat prefix that summons Garvis (must be a whole leading token). |
| `GARVIS_INGAME_REPLY_TARGET` | `@a` | Who sees replies: `@a` (everyone) or a player selector. "…thinking" acks always go privately to the asker. |
| `GARVIS_INGAME_COOLDOWN_MS` | `15000` | Per-player cooldown (each `!g` is a full `claude` turn). |
| `MC_CONTAINER` | `mc-neoforge` | Container to tail + `tellraw` into (shared with `/whitelist`). |

### Enable / apply

The bridge starts automatically with the bot (it shares the process). After
pulling these changes:

```bash
systemctl --user restart garvis-bot.service     # apply code changes
journalctl --user -u garvis-bot.service -f      # watch for: [ingame] watching container=…
```

Then in-game: `!g hello`.

### Security notes

- **Untrusted in-game chat is DATA.** The player's message is wrapped with
  `fencedData()` before it reaches the model — same discipline as every Discord
  path. The bridge never executes anything the player types.
- **No name spoofing.** The server stamps the real sender as the *first* `<name>`
  on the log line; a faked `<Bob> !g …` typed by Steve lands after `<Steve> ` and
  fails the trigger check. The reply targets `@a` (or a validated `3–16` char
  name), never raw player text.
- **No feedback loop.** `tellraw` output is delivered to clients, not re-logged as
  `<name>` chat, so Garvis can't trigger himself.
- **Same soft-boundary caveat as Discord.** The Q&A agent runs on the host with
  `AGENT_DENY_TOOLS` (denies docker/rcon + edits to the live server config/world),
  but — exactly as `docs/security.md` already states for the Discord Q&A path —
  pattern-based Bash denial is a **soft** control, and the spawned `claude`
  inherits the bot's environment. `!g` does not add a new class of risk (the same
  brain already answers any guild member's @mention), but it does widen *who* can
  reach it to anyone whitelisted in-game. **Recommended hardening (applies to both
  the in-game and Discord Q&A paths, do together):** strip non-essential secrets
  (`DISCORD_BOT_TOKEN`, `RCON_PASSWORD`) from the spawned agent's env, and add
  `Read(apps/server/.env)` to the deny list. The real boundary remains the
  OpenShell sandbox / the broker in the platform pivot.

### Known limits / future polish

- **Cost/load:** each `!g` spawns a `claude` process (seconds, CPU). The per-player
  cooldown bounds it; tune `GARVIS_INGAME_COOLDOWN_MS` if friends spam it.
- **Public questions:** the question is visible in chat (it's normal chat). Replies
  default to everyone (`@a`); set a player selector if you want them private.
- **Plain text only:** in-game chat renders no markdown/links, so the prompt forces
  short, plain answers. Modrinth link cards (Discord) don't apply here.

---

## Phase 2 — real `/g` slash command (PLANNED — not built yet)

Everything below is a **design sketch to build later**, not shipped.

### Why bother, given `!g` works

- A true `/g` is **private by default** (command args aren't broadcast to chat),
  **tab-completes**, and can't be confused with normal chat.
- The server hands the mod a **structured, trustworthy payload** (player UUID, not
  just a name; dimension; coords), instead of us scraping a log line.
- It's the "real product" — `!g` is the validate-the-idea version.

### Shape

A **small server-side-only NeoForge mod** (clients need nothing extra — server
commands sync to vanilla-on-NeoForge clients):

```
/g <message>
  → mod's RegisterCommandsEvent handler captures { uuid, name, dim, pos, message }
  → async HTTPS POST to a Garvis HTTP endpoint (shared secret; bound to the
    docker network / host-gateway, never public)
  → Garvis endpoint runs the SAME brain as `!g`/Discord and returns reply text
  → mod shows the reply to the player via command source feedback (private)
```

### What it would entail (the real cost — why it's deferred)

1. **A Java/Gradle mod build** added to this (currently all-JS/Docker) repo:
   a NeoForge MDK module, a `build.gradle`, the command + HTTP client, producing a
   jar dropped into `server-data/mods/` (it's not on Modrinth, so the existing
   deploy / client-pack machinery doesn't cover it — needs a build/copy step).
2. **A Garvis HTTP endpoint** (new small listener in `garvis-bot`, or a sidecar):
   `POST /ingame {player, uuid, message}` → reply. Reuses `runClaude` + the
   `mc:<uuid>` session map. Auth via a shared secret + bind to localhost/docker.
3. **Compose networking** so the `mc-neoforge` container can reach the host bot:
   add `extra_hosts: ["host.docker.internal:host-gateway"]` to the minecraft
   service and POST to `http://host.docker.internal:<port>` (or run the bot as a
   compose service on the shared network).
4. Same security model as `!g`: fence the message as data, per-player cooldown,
   Q&A-only to start. The structured UUID makes per-player identity *stronger*
   than the chat-name approach.

### Fit with the multi-tenant pivot

`docs/platform-architecture.md` favors Modrinth-only, platform-signed client
packs and treats arbitrary jars as a sharper edge (they run on players' PCs).
This mod is **server-side only** (never shipped to clients), so it sidesteps the
client-pack concern — but it's still a custom unsigned jar to build + maintain.
When the platform exists, the HTTP endpoint becomes the per-tenant agent's
slow-lane shim, and `/g` is just another front-end onto it.
