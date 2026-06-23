# minecraft

Monorepo for a modded **Minecraft Java Edition** server (NeoForge 1.21.x),
maintained asynchronously by a Claude Code agent and driven from Discord by
**@Garvis**. Each layer is an independent package under `apps/` / `infra/`.

## Architecture (5 layers)

| Layer | What | Where it runs | Status |
|------:|------|---------------|--------|
| 0 | Git repo — source of truth (compose, manifests, mod lists, guardrails) | this repo | ✅ scaffolded |
| 1 | Minecraft server — `itzg/minecraft-server`, NeoForge, TCP 25565 | a **normal** container / K8s pod | ✅ v1 ready |
| 2 | Maintenance agent — Hermes Agent + `claude-code` skill, cron, opens PRs | always-on host, **inside OpenShell** | 🧩 configured — confirm at install |
| 3 | @Garvis Discord bot — friends request mods, get Windows install help | Node service | 🧩 configured — runnable in dry-run |
| 4 | Exposure — itzg Helm chart, StatefulSet + PVC + L4 Service | Kubernetes | 🧩 configured — needs a cluster |
| 5 | OpenShell — egress sandbox around the **agent** (not the server) | OpenShell runtime | 🧩 configured — confirm CLI on your build |

**Bring-up order + every "confirm-at-install" item:** see `docs/install-runbook.md`.

> **Two corrections baked into this design** (see `docs/architecture.md`):
> 1. The Minecraft server does **not** run inside OpenShell — OpenShell is
>    egress-only and cannot host an inbound game listener. OpenShell wraps the
>    *agent*. 2. Kubernetes does **not** horizontally scale one world
>    (`replicaCount` stays 1); it gives self-healing + durable storage + clean
>    L4 exposure.

## Quickstart (Layer 1 — playable now)

```bash
cd apps/server
cp .env.example .env        # then edit: set LEVEL_SEED, MC_VERSION, mods…
docker compose up -d        # first boot downloads NeoForge + mods (be patient)
docker compose logs -f      # watch for "Done (…)! For help, type help"
```

From the repo root you can also use `npm run server:up` / `server:down` / `server:logs`.

Connect in-game to `your-host-ip:25565`. The **custom seed** is the `LEVEL_SEED`
value in `.env` (only applied on first world generation).

## Security

This repo lets semi-trusted friends drive an autonomous agent. Read
`docs/security.md` before exposing anything. **The Discord token shared in chat
is compromised — rotate it** (Developer Portal → Bot → Reset Token) and put the
new one only in `apps/garvis-bot/.env` (gitignored).

## Layout

```
apps/
  server/        Layer 1 — the game server (docker-compose.yml, .env, server-data/)
  garvis-bot/    Layer 3 — @Garvis Discord bot (Node)
  agent/         Layer 2 — Hermes + claude-code maintenance agent config
infra/
  k8s/           Layer 4 — Kubernetes manifests / Helm values
  openshell/     Layer 5 — agent egress sandbox policy
docs/            architecture, security, Windows client install guide
package.json     workspace root (npm workspaces + server/bot scripts)
CLAUDE.md        operational guardrails for the maintenance agent
```
