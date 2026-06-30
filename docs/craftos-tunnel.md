# CraftOS agent tunnel (`garvtunnel`)

An SSH-style tunnel into an in-game **CraftOS 1.9 (CC: Tweaked)** computer, built so
the maintainer's agent can run Lua and execute code on the computer remotely —
read/write files, drive peripherals/turtles, inspect state, push programs.

## Why this and not an existing tool

This was checked against prior art first. Remote access to CC computers has been
done several times, all riding CC: Tweaked's `http.websocket` API:

- **cloud-catcher** (SquidDev) — browser terminal + file editor for your computer.
- **CraftOS-PC Remote** + VS Code extension (MCJack123) — edit files / use the
  terminal of an in-game computer from inside VS Code.
- **turtleshell** (gingershaped) — literally "SSH for ComputerCraft" via a relay.
- **cc-socket-server** (wwaaijer) — a Node "C2" PoC that sends raw Lua over a
  WebSocket. This is the pattern `garvtunnel` is built on.

All of the above are **human-facing** (a TTY or a browser). `garvtunnel` is the
same WebSocket primitive shaped for an **agent**: submit a Lua chunk over HTTP,
get structured `{ok, output, returns, error}` back. Localhost-gated, token-gated.

## Architecture

```
┌─ minecraft container ─┐         ┌─ garvtunnel sidecar ─┐        ┌─ host ─┐
│  CC computer          │ ──WS──▶ │ :8176 /agent  (ws)   │        │        │
│  client.lua loop      │ ◀──────  │ :8176 /client.lua    │        │  agent │
│  load()+pcall+capture │  jobs   │ :8175 /exec  (ctl)   │ ◀─curl─ │ 127.0.0.1:8175
└───────────────────────┘         └──────────────────────┘        └────────┘
       internal docker net            token-gated            published host-only
```

- The computer **dials out** — there is no inbound port into the game.
- `:8176` (WS + bootstrap) is **internal only**; the minecraft container reaches
  it by the compose service name `garvtunnel`.
- `:8175` (control plane) is published to **`127.0.0.1` only**, matching the
  Grafana/Postgres sidecar pattern — only an on-box process can submit code.
- Every chunk runs under `load(code,"agent","t",env)` + `pcall`, where `env`
  captures `print`/`write` but falls through to all real CraftOS APIs via `_ENV`.

Files: `apps/server/garvtunnel/{server.js, client.lua, package.json, Dockerfile, cc}`.

## One-time setup

### 1. Set the token

In `apps/server/.env`:

```
TUNNEL_TOKEN=<paste output of: openssl rand -hex 24>
```

### 2. Allow the sidecar in CC: Tweaked's http rules  ← the only gotcha

CC: Tweaked denies `$private` (localhost + all private IPs) by default, which
blocks the internal `garvtunnel` address. In
`apps/server/server-data/config/computercraft-server.toml`, add an **allow** rule
for `garvtunnel` **above** the existing `$private` deny (rules are evaluated in
order; earlier wins):

```toml
	[[http.rules]]
		host = "garvtunnel"
		action = "allow"

	[[http.rules]]
		host = "$private"
		action = "deny"
```

> If matching by hostname doesn't take, pin the compose network to a fixed subnet
> and allow that CIDR instead (e.g. `host = "172.28.0.0/16"`).

Then restart the game server so CC reloads the config:

```
cd apps/server && docker compose restart minecraft
```

### 3. Start the sidecar

```
cd apps/server && docker compose up -d --build garvtunnel
```

### 4. Connect a computer (in-game)

On the CraftOS computer you want to expose, run (token as an argument so it never
lives in the served script):

```
wget run http://garvtunnel:8176/client.lua <TOKEN>
```

It prints `garvtunnel: connected` and starts its receive loop.

**Auto-reconnect on reboot:** install it as a startup file once —
`wget http://garvtunnel:8176/client.lua startup.lua` — then have `startup.lua`
read the token from a local file and call the loop (see the header of `client.lua`).

## Usage (from the host)

The `cc` helper wraps the control plane (`apps/server/garvtunnel/cc`, needs `curl` + `jq`):

```
./cc -s                                   # list connected computers
./cc 'print(2+2) return os.version()'     # run a chunk
./cc -f program.lua                        # run a local file on the computer
```

Raw equivalent:

```
curl -s -X POST http://127.0.0.1:8175/exec \
  -H "X-Tunnel-Token: $TUNNEL_TOKEN" -H 'content-type: application/json' \
  -d '{"code":"print(os.getComputerLabel()) return 1+1"}'
# → {"type":"result","jobId":"job-1","ok":true,"output":"...","returns":["2"]}
```

`POST /exec` body: `{ "code": "<lua>", "id": "<optional computer id>" }`.
Omit `id` to target the only/first connected computer.

## Security model

- **Localhost + token.** Control plane bound to `127.0.0.1`; both planes require
  `TUNNEL_TOKEN` (constant-time compared). The WS plane is never host-published.
- **Arbitrary code by design.** `/exec` runs unsandboxed Lua with full CraftOS API
  access on the target computer — that is the whole point. Anyone with the token
  *and* on-box access (or internal-network access) can drive the computer. Keep the
  token secret; rotate it by changing `.env` and `docker compose up -d garvtunnel`.
- **Blast radius** is one in-game computer (plus whatever it's wired to). It cannot
  touch the host — it's just a CC computer running Lua.

## Limitations / future

- Capturing `shell.run(...)` program output needs a term redirect (not wired yet);
  direct Lua via `/exec` is the primary, more powerful path.
- One synchronous job at a time per request; no streaming of long-running output.
- No persistent job log yet (could tee into the Postgres conversation store).
