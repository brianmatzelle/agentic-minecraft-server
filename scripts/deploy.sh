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
#   4. (--health-check) waits for the server to report "Done", and AUTO-ROLLS-BACK
#      to the previous mod set if it doesn't boot — see "Why --health-check" below.
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

# Wait until the server logs itzg's "Done (Ns)!" readiness marker, or a clearly-fatal
# mod-loading signature appears, or we time out. Returns 0 = ready, 1 = not ready.
# grep -m1 closes the pipe on the first match (SIGPIPE ends the follow); `timeout`
# bounds a silent hang. We only fast-fail on NeoForge's explicit "I give up" lines so a
# healthy boot (which logs plenty of benign warnings) is never mistaken for a crash.
wait_for_ready() {
  local timeout_s="$1" line=""
  echo "⏳ Waiting up to ${timeout_s}s for the server to report ready…"
  line="$(timeout "${timeout_s}" bash -c "cd '$SERVER_DIR' && docker compose logs -f --no-color --since 2s 2>&1 | grep -m1 -E ']: Done \\([0-9.]+s\\)!|Failed to load datapacks, can|A potential solution has been determined|Failed to start the minecraft server'" || true)"
  if printf '%s' "$line" | grep -qE ']: Done \([0-9.]+s\)!'; then
    echo "✅ Ready: ${line##*]: }"
    return 0
  fi
  [ -n "$line" ] && echo "❌ Boot looks broken: ${line}" || echo "❌ Timed out with no readiness marker after ${timeout_s}s."
  return 1
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
