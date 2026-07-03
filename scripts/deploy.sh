#!/usr/bin/env bash
# ── Deploy gate ──────────────────────────────────────────────────────────────
# Applies the repo's canonical mod list to the LIVE server. This is the single,
# reviewed step that sits between "repo changed" and "server changed" — the agent
# proposes changes via PR; a human (or the opt-in scripts/auto-deploy.sh watcher)
# merges; THIS script deploys them.
#
#   1. Reads apps/agent/modlist.txt  (one Modrinth slug per line, # comments ok)
#   2. Writes MODRINTH_PROJECTS=<slugs> into apps/server/.env
#   3. docker compose up -d           (itzg downloads mods at startup)
#   4. (--health-check) waits for the container's own healthcheck to report healthy,
#      and AUTO-ROLLS-BACK to the previous mod set if it doesn't boot — see below.
#
# Usage:
#   scripts/deploy.sh                      # sync modlist -> .env, recreate the container
#   scripts/deploy.sh --health-check       # ... then wait for boot; roll back on failure
#   scripts/deploy.sh --dry-run            # print what WOULD change, touch nothing
#   scripts/deploy.sh --no-up              # update .env only, don't restart the server
#   scripts/deploy.sh --health-check --timeout 600   # allow 10m for a heavy modded boot
#   scripts/deploy.sh --health-check --no-rollback   # report a bad boot but don't revert
#
# Why --health-check: a `docker compose up` re-resolves EVERY mod to its latest
# compatible build, so even an unrelated change (or no change) can pull a version that
# crash-loops boot (see docs — the cobblemon-mega-showdown datapack NPE). The health
# check turns "reach Done" into part of the deploy and reverts a server that won't start
# back to the last mod set that DID, so an auto-deploy can never leave the world down.
#
# Never touches server-data/ (the live world). Safe to re-run (idempotent).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODLIST="$REPO_ROOT/apps/agent/modlist.txt"
SERVER_DIR="$REPO_ROOT/apps/server"
ENV_FILE="$SERVER_DIR/.env"

DRY_RUN=0; DO_UP=1; HEALTH_CHECK=0; DO_ROLLBACK=1; TIMEOUT=420
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)      DRY_RUN=1 ;;
    --no-up)        DO_UP=0 ;;
    --health-check) HEALTH_CHECK=1 ;;
    --no-rollback)  DO_ROLLBACK=0 ;;
    --timeout)      shift; TIMEOUT="${1:?--timeout needs a value in seconds}" ;;
    --timeout=*)    TIMEOUT="${1#*=}" ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -f "$MODLIST" ]  || { echo "Missing modlist: $MODLIST" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "Missing env file: $ENV_FILE (copy .env.example first)" >&2; exit 1; }

# Strip comments + blank lines, trim whitespace, join slugs with commas.
slugs="$(sed -E 's/#.*$//' "$MODLIST" | awk 'NF{gsub(/[[:space:]]/,"");print}' | paste -sd, -)"

# The mod set currently live (from .env) BEFORE we touch it — the rollback target.
read_current_slugs() {
  grep -E '^[[:space:]]*MODRINTH_PROJECTS=' "$ENV_FILE" | head -1 | sed -E 's/^[^=]*=//' || true
}
PREV_SLUGS="$(read_current_slugs)"

# Replace or append MODRINTH_PROJECTS=<value> in .env (value only; keep file intact).
set_modrinth_projects() {
  local value="$1"
  if grep -qE '^[[:space:]]*MODRINTH_PROJECTS=' "$ENV_FILE"; then
    sed -i -E "s|^[[:space:]]*MODRINTH_PROJECTS=.*|MODRINTH_PROJECTS=${value}|" "$ENV_FILE"
  else
    printf 'MODRINTH_PROJECTS=%s\n' "$value" >> "$ENV_FILE"
  fi
}

compose_up() { ( cd "$SERVER_DIR" && docker compose up -d ); }

# Wait until the minecraft container's own healthcheck (itzg's mc-health — the same
# signal the backup/metrics sidecars gate on via `service_healthy`) reports healthy,
# or the container dies, or NeoForge logs an explicit fatal signature, or we time out.
# Returns 0 = ready, 1 = not ready.
#
# Deliberately NOT a live-log tail. The old `docker compose logs -f --since 2s |
# grep "Done"` was racy: a server whose Done line already printed (e.g. the
# auto-deploy watcher re-checking an already-deployed SHA) could NEVER match, so a
# healthy server "timed out" and got rolled back (near-miss 2026-07-02). The raw log
# stream is also full of ANSI color + CR control bytes that can break the grep even
# on a genuine fresh boot. Health polling has neither problem: an already-healthy
# container passes immediately, and a fresh boot passes as soon as mc-health does.
# We only fast-fail on the container dying or NeoForge's explicit "I give up" lines,
# so a healthy boot (which logs plenty of benign warnings) is never mistaken for a
# crash.
wait_for_ready() {
  local timeout_s="$1" waited=0 interval=5
  local cid="" state="" health="" started="" matched=""
  echo "⏳ Waiting up to ${timeout_s}s for the container healthcheck to report healthy…"
  while :; do
    cid="$( (cd "$SERVER_DIR" && docker compose ps -aq minecraft) 2>/dev/null | head -1 || true)"
    state=""; health=""
    if [ -n "$cid" ]; then
      state="$(docker inspect --format '{{.State.Status}}' "$cid" 2>/dev/null || true)"
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || true)"
      started="$(docker inspect --format '{{.State.StartedAt}}' "$cid" 2>/dev/null || true)"
      if [ "$state" = "running" ] && [ "$health" = "healthy" ]; then
        echo "✅ Ready: container healthcheck is healthy (after ${waited}s)."
        return 0
      fi
      if [ "$state" = "exited" ] || [ "$state" = "dead" ]; then
        echo "❌ Boot looks broken: container is ${state}."
        return 1
      fi
      # No healthcheck on the image (shouldn't happen with itzg) — fall back to this
      # boot's persisted Done marker, ANSI/CR-stripped. -a: the stream has control
      # bytes that make grep treat it as binary otherwise.
      if [ "$state" = "running" ] && [ "$health" = "none" ]; then
        matched="$(docker logs --since "${started:-5m}" "$cid" 2>&1 | sed 's/\x1b\[[0-9;]*[mK]//g' | tr -d '\r' | grep -m1 -aE ']: Done \([0-9.]+s\)!' || true)"
        if [ -n "$matched" ]; then
          echo "✅ Ready: ${matched##*]: } (no container healthcheck; matched boot log)"
          return 0
        fi
      fi
      # NeoForge's explicit "I give up" lines → fail fast instead of waiting out the
      # clock. Scoped to the current boot's logs via --since StartedAt.
      matched="$(docker logs --since "${started:-5m}" "$cid" 2>&1 | sed 's/\x1b\[[0-9;]*[mK]//g' | tr -d '\r' | grep -m1 -aE 'Failed to load datapacks, can|A potential solution has been determined|Failed to start the minecraft server' || true)"
      if [ -n "$matched" ]; then
        echo "❌ Boot looks broken: ${matched}"
        return 1
      fi
    fi
    if [ "$waited" -ge "$timeout_s" ]; then
      echo "❌ Timed out after ${timeout_s}s (container: ${state:-not found}, health: ${health:-n/a})."
      return 1
    fi
    sleep "$interval"
    waited=$((waited + interval))
    if [ $((waited % 30)) -eq 0 ]; then
      echo "   …${waited}s (container: ${state:-not found}, health: ${health:-n/a})"
    fi
  done
}

echo "Canonical mods -> ${slugs:-(none)}"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] would set MODRINTH_PROJECTS=${slugs} in $ENV_FILE (was: ${PREV_SLUGS:-<unset>})"
  echo "[dry-run] would run: (cd $SERVER_DIR && docker compose up -d)"
  [ "$HEALTH_CHECK" -eq 1 ] && echo "[dry-run] would wait ${TIMEOUT}s for readiness; rollback=$([ $DO_ROLLBACK -eq 1 ] && echo on || echo off)"
  exit 0
fi

set_modrinth_projects "$slugs"
echo "Updated MODRINTH_PROJECTS in $ENV_FILE"

if [ "$DO_UP" -eq 0 ]; then
  echo "--no-up: .env updated, server NOT restarted."
  exit 0
fi

echo "Recreating the server container (itzg will fetch any new mods on boot)…"
compose_up

if [ "$HEALTH_CHECK" -eq 0 ]; then
  echo "Done. Watch boot: (cd $SERVER_DIR && docker compose logs -f)"
  exit 0
fi

if wait_for_ready "$TIMEOUT"; then
  echo "🎉 Deploy healthy."
  exit 0
fi

# Boot failed. Roll back to the previous mod set if we have one and rollback is enabled.
if [ "$DO_ROLLBACK" -eq 1 ] && [ -n "$PREV_SLUGS" ] && [ "$slugs" != "$PREV_SLUGS" ]; then
  echo "⏪ Rolling back MODRINTH_PROJECTS to the previous set and redeploying…"
  set_modrinth_projects "$PREV_SLUGS"
  compose_up
  if wait_for_ready "$TIMEOUT"; then
    echo "✅ Rolled back to the previous mod set — server is healthy again."
  else
    echo "🚨 Rollback redeploy ALSO failed to report ready — MANUAL INTERVENTION NEEDED." >&2
  fi
  echo "DEPLOY FAILED: the new mod set broke boot; reverted to the previous set ('${PREV_SLUGS}')." >&2
  exit 3
fi

echo "DEPLOY FAILED: server did not become ready (rollback disabled, or no previous set to revert to)." >&2
exit 3
