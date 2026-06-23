#!/usr/bin/env bash
# ── Deploy gate ──────────────────────────────────────────────────────────────
# Applies the repo's canonical mod list to the LIVE server. This is the single,
# reviewed step that sits between "repo changed" and "server changed" — the agent
# proposes changes via PR; a human merges; THIS script deploys them.
#
#   1. Reads apps/agent/modlist.txt  (one Modrinth slug per line, # comments ok)
#   2. Writes MODRINTH_PROJECTS=<slugs> into apps/server/.env
#   3. docker compose up -d           (itzg downloads mods at startup)
#
# Usage:
#   scripts/deploy.sh            # sync modlist -> .env, recreate the container
#   scripts/deploy.sh --dry-run  # print what WOULD change, touch nothing
#   scripts/deploy.sh --no-up     # update .env only, don't restart the server
#
# Never touches server-data/ (the live world). Safe to re-run (idempotent).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODLIST="$REPO_ROOT/apps/agent/modlist.txt"
SERVER_DIR="$REPO_ROOT/apps/server"
ENV_FILE="$SERVER_DIR/.env"

DRY_RUN=0; DO_UP=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-up)   DO_UP=0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

[ -f "$MODLIST" ]  || { echo "Missing modlist: $MODLIST" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "Missing env file: $ENV_FILE (copy .env.example first)" >&2; exit 1; }

# Strip comments + blank lines, trim whitespace, join slugs with commas.
slugs="$(sed -E 's/#.*$//' "$MODLIST" | awk 'NF{gsub(/[[:space:]]/,"");print}' | paste -sd, -)"

echo "Canonical mods -> ${slugs:-(none)}"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] would set MODRINTH_PROJECTS=${slugs} in $ENV_FILE"
  echo "[dry-run] would run: (cd $SERVER_DIR && docker compose up -d)"
  exit 0
fi

# Replace or append MODRINTH_PROJECTS in .env (value only; keep file otherwise intact).
if grep -qE '^[[:space:]]*MODRINTH_PROJECTS=' "$ENV_FILE"; then
  sed -i -E "s|^[[:space:]]*MODRINTH_PROJECTS=.*|MODRINTH_PROJECTS=${slugs}|" "$ENV_FILE"
else
  printf 'MODRINTH_PROJECTS=%s\n' "$slugs" >> "$ENV_FILE"
fi
echo "Updated MODRINTH_PROJECTS in $ENV_FILE"

if [ "$DO_UP" -eq 1 ]; then
  echo "Recreating the server container (itzg will fetch any new mods on boot)…"
  ( cd "$SERVER_DIR" && docker compose up -d )
  echo "Done. Watch boot: (cd $SERVER_DIR && docker compose logs -f)"
else
  echo "--no-up: .env updated, server NOT restarted."
fi
