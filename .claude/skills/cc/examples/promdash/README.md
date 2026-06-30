# promdash — live server metrics on CraftOS 📊

A worked `/cc` example: an in-game dashboard that renders the **same data as the
Grafana "Server Performance" dashboard** — TPS, MSPT, players online, heap %, a
TPS history band, and per-player ping — on a ComputerCraft terminal **or a
monitor wall**. Built & verified live 2026-06-30.

Grafana itself is a React web app and **cannot** render in CraftOS (no DOM, no
real JS engine — CC runs Lua 5.2 on Cobalt). But the dashboard is just PromQL
queries against Prometheus, which has a plain **JSON query API** — so `promdash`
hits that directly and redraws the panels natively in 16 colors.

## Architecture (one device, no mod required)

```
 ┌─ advanced computer (e.g. computer-2) ─┐   http.get (JSON)    ┌─ mc-prometheus ─┐
 │ runs promdash.lua in a multishell tab │ ──/api/v1/query?───▶ │ :9090 sidecar   │
 │   • 5 instant PromQL queries / 5s     │ ◀──{status,data}──── │ scrapes the     │
 │   • parses JSON, draws tiles+bars     │   internal network   │ exporter mod    │
 │   • renders to monitor if attached,   │                      └─────────────────┘
 │     else its own terminal             │
 └────────────────────────────────────────┘
```

`prometheus` is reached by its **compose service name** over the internal Docker
network — the same path the `garvtunnel` sidecar uses. The exporter mod, the
Prometheus sidecar, and the Grafana dashboard it mirrors all live in
`apps/server/` (`docker-compose.yml` + `monitoring/`).

## The one prerequisite: an http allow-rule (no restart needed)

CC: Tweaked blocks HTTP to private/internal IPs by default via its `$private`
rule, so an in-game `http.get("http://prometheus:9090/...")` returns
**`Domain not permitted`**. Add an allow-rule for the `prometheus` host **above**
that deny, in `apps/server/server-data/config/computercraft-server.toml`:

```toml
	[[http.rules]]
		host = "prometheus"
		action = "allow"
	[[http.rules]]
		host = "$private"
		action = "deny"
```

> **NeoForge hot-reloads this.** Its config watcher rebuilds CC:T's http rules the
> moment you save the `.toml` — **no server restart required**, and the rule is
> persistent (it survives reboots since it lives in the config file). Verify it's
> live from the host:
> ```bash
> apps/server/garvtunnel/cc -i 2 'local h=http.get("http://prometheus:9090/-/healthy") return h and h.readAll() or "blocked"'
> ```
> Expect `Prometheus Server is Healthy.` — if you get `blocked`, the rule isn't in
> place. (Until then `promdash` shows a banner explaining the fix instead of data.)

## Run it (from repo root)

```bash
# confirm the target computer is on the tunnel (advanced/color computer recommended)
apps/server/garvtunnel/cc -s

# deploy + launch on its own SCREEN (focuses the tab in-game):
CCDEPLOY_ID=2 .claude/skills/cc/scripts/ccdeploy \
  .claude/skills/cc/examples/promdash/promdash.lua /promdash.lua promdash
```

`CCDEPLOY_ID=<id>` picks the computer (`cc -s` lists ids). It runs in a background
multishell tab, so it coexists with anything else on that computer (on computer-2
it sits alongside the follow-turtle host controller).

## Show it on a MONITOR wall

`promdash` calls `peripheral.find("monitor")` and is **hot-pluggable** — attach or
remove a monitor while it's running and it switches automatically. It's also
**responsive**: on a monitor it auto-picks the text scale whose character grid is
closest to `TARGET_COLS` (default 50) and lays the whole dashboard out
proportionally, so it fills the board with big readable content no matter how many
blocks you wire up. (A 7×5 advanced-monitor wall is 143×67 cells at scale 0.5 but
auto-selects scale 1.5 → 48×22; lower `TARGET_COLS` for even bigger text.) To build
a wall:

1. **Use ADVANCED monitors** (gold border) — plain monitors are monochrome, so the
   green/yellow/red health colors won't show. The layout auto-adapts to the screen
   size; a **2×2 or 3×2** advanced-monitor array makes a roomy, readable board.
2. **Attach it to the computer**, either:
   - **Adjacent** — place the monitor block directly touching the computer. `find`
     picks it up on any side. (For a multi-block array, place the rectangle of
     monitors first; they auto-merge into one big screen.)
   - **Over wired network** — put a **Wired Modem** on the computer and one on the
     monitor (or adjacent to the array), run **Networking Cable** between them, and
     **right-click both modems** to activate (the ring lights up). The monitor then
     joins as `monitor_0` and `find` returns it — handy for a screen across the room.
3. **Launch with `CCDEPLOY_NOFOCUS=1`** so it doesn't steal the computer's own
   screen (the dashboard is on the monitor anyway):
   ```bash
   CCDEPLOY_ID=2 CCDEPLOY_NOFOCUS=1 .claude/skills/cc/scripts/ccdeploy \
     .claude/skills/cc/examples/promdash/promdash.lua /promdash.lua promdash
   ```

> Live since 2026-06-30 on computer-2 driving a 7×5 advanced-monitor wall
> (auto-selected scale 1.5 → 48×22).

## Stop

```bash
apps/server/garvtunnel/cc -i 2 'os.queueEvent("cc_stop")'   # ask promdash to quit
```
…or press **q** at the computer/monitor in-game.

## Customize

- **Display size** — `TARGET_COLS` (top of file): the dashboard auto-picks the
  monitor text scale whose width lands closest to this. **Lower = bigger text /
  fewer columns** (e.g. 36 → scale 2.0 here), higher = denser (71 → scale 1.0).
  Ignored in terminal mode (a computer's own screen has a fixed scale).
- **Refresh rate** — `REFRESH` (seconds) at the top.
- **Thresholds / colors** — the `health(v, g1, g2, higherBetter)` calls in `draw`
  (e.g. TPS lime ≥19.5 / yellow ≥15; MSPT lime ≤40 / yellow ≤50; heap lime <70% /
  yellow <85%; ping lime <80ms / yellow <200ms).
- **Add panels** — drop another PromQL string into `Q` and draw it. The queries are
  copied verbatim from the Grafana dashboard (`apps/server/monitoring/grafana/
  dashboards/minecraft.json`), so any panel there is reproducible here.

## Limits (v1)

- **Color needs advanced hardware** — advanced computer for the terminal view,
  advanced monitors for a color wall.
- **Instant values only** — the four stat tiles + ping are instant queries; the only
  history is the in-memory TPS band. Grafana's true timeseries panels (heap-over-
  time, GC/s, chunks & entities by dimension) aren't reproduced — add `query_range`
  calls if you want real graphs.
- **Blocking fetches** — the ~5 sequential `http.get`s briefly pause the event loop
  each cycle; fine at a 5s refresh, don't crank it too low.
- **Player names** depend on the exporter's label (`mc_player_ping_seconds`); the
  code tries `player`/`name`/`username`/`uuid`/`id` and falls back to `?`.
```
