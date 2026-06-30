# ComputerCraft dev guide (garvtunnel)

Full reference for the `/cc` skill. Architecture & one-time setup: `docs/craftos-tunnel.md`.

## The environment
- A live **CraftOS 1.9 (CC: Tweaked)** computer in the running Minecraft server, connected OUT to
  the `garvtunnel` sidecar. You submit Lua to a host-only control plane (`127.0.0.1:8175`, token in
  `apps/server/.env`) and get `{ok, output, returns, error}` back. No inbound port into the game.
- `client.lua` runs each submitted chunk under `load()+pcall` in an env that captures `print`/`write`
  and falls through to **all** real CraftOS APIs (`fs`, `term`, `peripheral`, `shell`, `multishell`,
  `paintutils`, `turtle`, ...). `print`/`write` output comes back in `output`; Lua return values come
  back serialized in `returns`.

## Probe first
Always check the box before building (term size differs per computer; peripherals/turtle vary):
```
apps/server/garvtunnel/cc '
local w,h = term.getSize()
return textutils.serialize({
  version=os.version(), id=os.getComputerID(), label=os.getComputerLabel(),
  term=w.."x"..h, color=term.isColour(), isTurtle=(turtle~=nil),
  peripherals=peripheral.getNames(), free=fs.getFreeSpace("/"), files=fs.list("/"),
})'
```

## Execution model & the wedge trap
- Each chunk runs to completion **before** the client reads the next message → one job at a time.
- **15s** control-plane timeout (`TUNNEL_EXEC_TIMEOUT_MS`): the *agent* gets a 504, but the chunk
  keeps running on the computer.
- A **CPU-bound** infinite loop is killed by CC's ~7s "Too long without yielding" watchdog → the
  client recovers and returns the error. Survivable but messy.
- A **yielding** infinite loop (`sleep`, `os.pullEvent`, `coroutine.yield`) never trips the watchdog
  → it **wedges that computer forever**. The only recovery is rebooting the computer **in-game**
  (you can't send more exec once it's wedged). So: **long-running work always goes in a background
  tab, never inline.**

## Backgrounding via multishell (advanced computers)
`ccdeploy` does this for you; the manual form:
```lua
local id = shell.openTab("/game.lua")          -- runs concurrently, own terminal window
multishell.setTitle(id, "game")
multishell.setFocus(id)                          -- so the in-game viewer sees it
```
- Background tabs run concurrently with the client tab — the tunnel stays responsive (verify with
  `cc -s`). All tabs receive every event, so you can signal across tabs (see stop convention).
- **A program inside a tab sees a terminal 1 row shorter** — multishell draws its tab bar on the real
  top row. Always use `term.getSize()` dynamically; never hardcode 51x18.

## Stop convention (remote control without keystrokes)
Keystrokes can't ride the tunnel. Make long-running programs listen for a custom event, then stop
them from the host with `os.queueEvent` (events reach all tabs):
```lua
-- in the program's event loop:
local e = { os.pullEvent() }
if e[1] == "key" and e[2] == keys.q then break end
if e[1] == "cc_stop" then break end
```
```
apps/server/garvtunnel/cc 'os.queueEvent("cc_stop")'   -- ask all programs to quit
```

## Terminal & color (advanced/color computer)
- Fast full-color fill: `term.blit(text, fgHex, bgHex)` — three equal-length strings; each color is
  one hex char:
  `0`white `1`orange `2`magenta `3`lightBlue `4`yellow `5`lime `6`pink `7`gray
  `8`lightGray `9`cyan `a`purple `b`blue `c`brown `d`green `e`red `f`black.
  Build one string per row and blit it — far faster than per-cell `setBackgroundColor`+`write`.
- `paintutils` (`drawLine`, `drawBox`, `drawPixel`) also available. `colors.*` constants for the
  non-blit term calls.
- Reset on exit: `term.setBackgroundColor(colors.black); term.setTextColor(colors.white); term.clear();
  term.setCursorPos(1,1)`.

## Program template (event-loop, focus-safe, stoppable)
```lua
local W, H = term.getSize()
local function draw() --[[ ... ]] end
draw()
local tick = os.startTimer(0.1)
while true do
  local e = { os.pullEvent() }
  if e[1] == "timer" and e[2] == tick then
    -- update + draw
    tick = os.startTimer(0.1)
  elseif e[1] == "key" then
    if e[2] == keys.q then break end
  elseif e[1] == "cc_stop" then break
  elseif e[1] == "term_resize" then W, H = term.getSize(); draw()
  end
end
term.setBackgroundColor(colors.black); term.setTextColor(colors.white); term.clear(); term.setCursorPos(1,1)
print("stopped.")
```

## ccdeploy
`.claude/skills/cc/scripts/ccdeploy <file.lua> [remote-path] [tab-title]` — base64-encodes the local
file, writes it to the computer (`remote-path`, default `/<basename>`), and `shell.openTab`s it with
focus. Env flags: `CCDEPLOY_NOFOCUS=1` (don't switch the screen), `CCDEPLOY_NOLAUNCH=1` (write only).
Re-running overwrites the file and opens a **new** tab — old tabs of a prior version keep running, so
`os.queueEvent("cc_stop")` (or `q` in-game) the old one when iterating on a long-running program.

## Recovery
- **Wedged tunnel** (`cc -s` hangs/empty after a bad inline loop): the computer must be rebooted
  in-game (`Ctrl+R` held, or break+replace). Then it auto-reconnects via its `startup.lua`.
- **Tab clutter**: `os.queueEvent("cc_stop")` to drop cooperating programs; or reboot in-game for a
  clean slate.
- **Verify the client is alive** anytime: `apps/server/garvtunnel/cc -s`.
