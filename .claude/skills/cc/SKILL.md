---
name: cc
description: ComputerCraft mode — build, run, and iterate on CC: Tweaked (CraftOS) Lua apps inside the live in-game computer via the garvtunnel sidecar. Use when asked to make/run/fix a ComputerCraft program on the server's computer or turtle. Invoked as /cc <what to build>.
argument-hint: "[what to build, e.g. \"make the game pong\"]"
allowed-tools: "Read, Write, Edit, Bash(apps/server/garvtunnel/cc*), Bash(.claude/skills/cc/scripts/ccdeploy*), Bash(docker compose*), Bash(docker ps*)"
---

# cc — ComputerCraft mode (build CC: Tweaked apps via garvtunnel)

**Build / run / iterate `$ARGUMENTS`** on a live in-game **CraftOS 1.9 (CC: Tweaked)** computer
over the `garvtunnel` sidecar. (Empty arg → ask what to build.) Read `references/dev-guide.md`
once per session — the env-probe chunk, color/blit table, multishell facts, a program template,
and recovery all live there.

## Toolchain (run from repo root)
- `apps/server/garvtunnel/cc 'lua'` — run a chunk → JSON `{ok,output,returns,error}`.
- `apps/server/garvtunnel/cc -f f.lua` — run a local file's contents as a chunk (does **not** install it).
- `apps/server/garvtunnel/cc -s` — list connected computers.
- `apps/server/garvtunnel/cc -i <id> …` — target a **specific** device (see `-s` for ids). With >1
  device connected, bare `cc`/`ccdeploy` hit only the first-connected one, so name the one you mean.
- `.claude/skills/cc/scripts/ccdeploy <file.lua> [remote] [title]` — **install** a local file onto the
  computer + launch it in a focused multishell tab (base64, survives any bytes).
  `CCDEPLOY_NOFOCUS=1` launches without stealing the screen; `CCDEPLOY_NOLAUNCH=1` just writes the file;
  `CCDEPLOY_ID=<id>` targets a specific device.

**Connecting a new computer/turtle** (manual first-time bootstrap) and **multi-device targeting** are
documented in `references/dev-guide.md` — read it when a device isn't on the tunnel yet.

## Three hard rules
1. **<15s per chunk** — the control plane times out at 15s.
2. **Never send a loop inline.** The client runs each chunk *synchronously* in its receive loop; a
   *yielding* infinite loop (`while true do sleep() end`) **wedges the tunnel until an in-game reboot**.
   Anything long-running or interactive goes to a **file + background multishell tab** (`ccdeploy`),
   never an inline `/exec`. Inline is for probes and one-shots only.
3. **No keystrokes over the tunnel.** Games are played at the computer in-game; stop a backgrounded
   program remotely with `apps/server/garvtunnel/cc 'os.queueEvent("cc_stop")'` (programs listen for it).

## Loop
**Probe** the box (guide) → **author** locally in scratchpad — event-loop driven (`os.pullEvent` +
repeating `os.startTimer`), honor `q` and `cc_stop` to exit, read `term.getSize()` dynamically (inside
a tab the screen is **1 row shorter** — top row is the tab bar) → **`ccdeploy game.lua`** then
`apps/server/garvtunnel/cc 'local fn,e=loadfile("/game.lua") return fn and "ok" or tostring(e)'` to
confirm it compiled → **verify** `cc -s` still answers (proves the tunnel survived) and **ask the user
what's on screen** (you cannot see it) → iterate (re-`ccdeploy` overwrites + relaunches).

> A skill folder created mid-session may need a Claude Code restart before `/cc` shows in `/`.
