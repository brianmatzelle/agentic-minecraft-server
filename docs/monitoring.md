# Server performance monitoring — Prometheus + Grafana

We can now **watch** server performance over time instead of guessing. This exists so
resource-affecting changes (raising `view-distance`, adding entity-heavy mods, more
players) can be made **measurably** — take a baseline, make the change, compare the
graphs — rather than blind. It's the prerequisite we set for revisiting the
`view-distance` 16 → 24 bump.

## What runs

Three pieces, all in `apps/server/docker-compose.yml`:

1. **`prometheus-exporter` mod** (server-side) — the
   [cpburnz mod](https://github.com/cpburnz/minecraft-prometheus-exporter), added via
   itzg's `MODS` URL so it's reproducible and git-tracked. It runs **inside** the
   `minecraft` container and exposes `/metrics` on port **19565**. It's server-only
   (not in the client modpack, no client install, no parity impact — same as `spark`).
2. **`prometheus`** sidecar — scrapes that endpoint every 15s and stores the history
   (30-day / 2 GB retention cap).
3. **`grafana`** sidecar — auto-provisioned with the Prometheus datasource and the
   **"Minecraft — Server Performance"** dashboard.

```
minecraft (exporter :19565)  ──scrape──>  prometheus  ──query──>  grafana  ──SSH tunnel──>  you
        (internal compose network only)                        (127.0.0.1:3000)
```

The exporter port is **never published to the host** — only Prometheus reaches it over
the internal compose network. Grafana is bound to **`127.0.0.1` only**.

## Viewing the dashboards

Grafana has no off-box auth story yet, so it's localhost-only. Reach it with an SSH tunnel:

```bash
ssh -L 3000:localhost:3000 <this-box>
# then open http://localhost:3000  →  login: admin / $GRAFANA_ADMIN_PASSWORD
```

Set a real `GRAFANA_ADMIN_PASSWORD` in `apps/server/.env` (defaults to `admin`).
The dashboard lives under the **Minecraft** folder → **Minecraft — Server Performance**.

## What the panels mean (for the view-distance call)

| Panel | Metric | Why it matters |
|---|---|---|
| **TPS** | derived from `mc_server_tick_seconds` | 20 = healthy. Sustained < 20 = the server can't keep up. |
| **Avg MSPT** | `mc_server_tick_seconds` | Milliseconds per tick. **Must stay < 50ms** to hold 20 TPS. This is the single-thread tick budget. |
| **Tick time avg & p95** | `mc_server_tick_seconds_bucket` | p95 catches the spikes the average hides. |
| **Heap used / max** | `jvm_memory_bytes_used/max{area=heap}` | `view-distance` costs **memory** (more loaded chunks). Watch for the ceiling + sawtooth getting tight. |
| **GC time/sec** | `jvm_gc_collection_seconds_sum` | Rising GC time → heap pressure → stalls. |
| **Loaded chunks by dimension** | `mc_dimension_chunks_loaded` | `view-distance` directly inflates this. The clearest "what did the bump cost" signal. |
| **Entities by dimension** | `mc_entities_total` | Entity load is the usual modded TPS killer (Cobblemon). |

## The whole point: measuring a config change

1. **Baseline.** Let it collect under a realistic load (a few players on). Note the steady-state
   MSPT, heap, and loaded-chunk counts at the current `view-distance=16`.
2. **Change one thing.** Raise `VIEW_DISTANCE` in `docker-compose.yml`, and update the two
   correlation labels in `monitoring/prometheus/prometheus.yml` (`view_distance` /
   `simulation_distance`) to match. Restart.
3. **Mark it.** Drop a **Grafana annotation** at the moment of the change (Ctrl-click a
   graph → *Add annotation*), so before/after is unmistakable on the timeline.
4. **Compare.** Watch MSPT p95 and heap headroom for a session. If MSPT stays comfortably
   under 50ms and heap isn't pinned, the bump is safe — keep it. If not, revert; now you
   have data, not a hunch.

The `view_distance` / `simulation_distance` **scrape labels** stamp the active config onto
every sample — so "show me MSPT at vd=16 vs vd=24" is a label filter in Grafana, not
archaeology. (This is the "metrics against config" idea, done declaratively.)

## Going deeper: spark

The dashboards tell you *that* something is slow; **`spark`** (already installed) tells you
*where*. When a number looks bad, profile in-game or from the server console:

```
/spark profiler --timeout 300     # 5-min sample, returns a flamegraph link
/spark tps                        # instant TPS/MSPT snapshot
/spark health                     # CPU, memory, tick stats
```

(spark's output goes to the in-game/console sender, not back over `rcon-cli` — run it in-game
or read it from the server console. Continuous numbers come from Grafana.)

## Operating notes

- **Retention / disk:** capped at 30 days **or** 2 GB (whichever first) via the
  `prometheus` service `command:` flags. Bump there if you want more history.
- **Pin the images:** `prometheus` and `grafana` use `:latest` for a clean first boot.
  Once you've confirmed a working version, pin the exact tags in `docker-compose.yml`.
- **Bump the exporter:** swap the release URL in `MODS` for the matching MC+loader build
  from the [releases page](https://github.com/cpburnz/minecraft-prometheus-exporter/releases).
- **Debug Prometheus targets:** uncomment the `127.0.0.1:9090:9090` mapping on the
  `prometheus` service, tunnel to it, and open `/targets` — the `minecraft` job should be **UP**.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Grafana panels say "No data" | Server still booting (exporter not up yet), or < 1 scrape interval of data. Wait ~1 min. |
| Prometheus `minecraft` target **DOWN** | Exporter mod didn't load — check `docker compose logs minecraft` for the jar download + a "prometheus" line; confirm port 19565. |
| TPS/MSPT panels empty but heap works | `mc` collector disabled — check `mc = true` in `config/prometheus_exporter-server.toml` (auto-generated in `server-data`). |
| Players-online stuck at 0 | Expected when nobody's on (`mc_player_list` has no series); the panel coalesces to 0. |
