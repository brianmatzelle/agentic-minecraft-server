# Install runbook

Bring the stack up in this order. Each layer works standalone, so you can stop
after any step. Config blocks across the repo are tagged `[VERIFIED]` (from a
re-checked primary source) or `[ILLUSTRATIVE]` (confirm against your installed
build — collected under "Confirm at install" per layer).

## 0. Prerequisites
- [ ] **Rotate the Discord token** (Developer Portal → Bot → Reset Token). The one
      shared in chat is burned. New token goes only in `bot/.env` / `~/.hermes/.env`.
- [ ] Grab `DISCORD_APP_ID`, `DISCORD_GUILD_ID`, the mod-request channel ID, and the
      Discord user/role IDs allowed to drive @Garvis.
- [ ] Decide hosting: single-box Docker (fastest) or Kubernetes (you chose K8s).

## 1. Minecraft server (Layer 1) — playable now
```bash
cp .env.example .env          # set LEVEL_SEED, MC_VERSION=1.21.1, MODRINTH_PROJECTS
docker compose up -d
docker compose logs -f        # wait for "Done (…)! For help, type help"
```
Connect to `host-ip:25565`. Custom seed = `LEVEL_SEED` (first world-gen only).

## 2. @Garvis bot (Layer 3) — start in dry-run
```bash
cd bot && npm install
cp .env.example .env          # DISCORD_* + allowlist; GARVIS_DISPATCH_MODE=dry-run
npm run register && npm start
```
`/installhelp` and `/requestmod` work immediately; `/requestmod` shows the scoped
task it *would* run. Wire `GARVIS_DISPATCH_MODE=openshell` only after Layer 5.

## 3. Maintenance agent (Layer 2)
- Copy `agent/config.yaml` → `~/.hermes/config.yaml`; run `hermes setup`.
- Append `agent/discord.env.example` → `~/.hermes/.env` (rotated token, allowlist).
- Create the cron job via the `hermes cron` CLI using `agent/cron-job.example.json` as the spec.
- The agent runs `claude` with `--settings agent/claude/settings.json`; install
  `agent/claude/managed-settings.json` to the image's managed path and register
  `agent/claude/hooks/block-downloaders.sh` as a PreToolUse hook.

## 4. OpenShell sandbox (Layer 5)
```bash
bash openshell/run.sh         # register gateway → create sandbox → policy set → connect
```
Then set the bot's `GARVIS_DISPATCH_MODE=openshell` and point it at the sandbox name.

## 5. Kubernetes (Layer 4)
```bash
helm repo add itzg https://itzg.github.io/minecraft-server-charts/
helm upgrade --install mc itzg/minecraft -f k8s/values.yaml
```

---

## Master "confirm at install" checklist
**OpenShell**
- [ ] `openshell sandbox create` flags + whether `<name>` is required (`--help`).
- [ ] Supervisor keep-alive across disconnect (undocumented) — else self-supervise Hermes.
- [ ] `binaries[].path` in `policy.yaml` match `which git curl gh node claude` in the image.
- [ ] `policy set` arg order; `policy update` incremental flag spellings.

**Hermes**
- [ ] `config.yaml` keys exist on your build (`hermes setup` migrates `_config_version`).
- [ ] `DISCORD_ALLOWED_USERS/ROLES` + `REQUIRE_MENTION` actually enforced (authz gate).
- [ ] Exact `deliver` value that routes cron output to Discord.
- [ ] Hermes install method in `openshell/Dockerfile` (pin a version).

**Claude Code**
- [ ] `managed-settings.json` delivery path on the image (else no effect).
- [ ] Pair `--output-format stream-json` with `--verbose` in headless runs.

**Kubernetes**
- [ ] Current NeoForge `21.1.x` build for `extraEnv.NEOFORGE_VERSION` (`maven.neoforged.net`).
- [ ] Env-passthrough key (`extraEnv` vs `env`); pin chart `version`.
- [ ] Cluster has a LoadBalancer provider (or use NodePort + MetalLB).

**Mods**
- [ ] Re-check the 5 starter-mod versions for newer 1.21.1 builds at deploy.
