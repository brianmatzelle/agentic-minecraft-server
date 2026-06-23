#!/usr/bin/env bash
# ops-tripwire — audit alarm for privileged admin actions on the LIVE server.
#
# Follows the Minecraft server log and raises an ALERT line (to stdout, captured by
# journald when run as the systemd unit) whenever someone is opped/de-opped, banned,
# the whitelist is toggled, or an RCON command runs — no matter who triggered it
# (owner, Garvis's agent, or an attacker). Best-effort also flags writes to the live
# ops/whitelist files and apps/server/.env if `inotifywait` is available.
#
# This is a DETECTIVE control, not a preventive one — it tells you an escalation
# happened (or was attempted), so the prompt-level + deny-rule guardrails aren't the
# only thing standing between a prompt injection and a silent admin takeover.
# Pair with the deny rules (apps/garvis-bot) and, ultimately, the OpenShell sandbox.
set -uo pipefail

CONTAINER="${MC_CONTAINER:-mc-neoforge}"
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# Server-log signatures of privileged actions (case-insensitive).
LOG_PATTERN='Made .* a server operator|De-opped|Opped |Banned|ban-ip|Pardoned|Un-banned|Added .* to the whitelist|Removed .* from the whitelist|Turned (on|off) the whitelist|\[Rcon|set own game mode|set .* game mode to'

ts() { date '+%F %T'; }
alert() { printf '%s [ops-tripwire] 🚨 ALERT: %s\n' "$(ts)" "$1"; }
note()  { printf '%s [ops-tripwire] %s\n' "$(ts)" "$1"; }

note "watching container=$CONTAINER repo=$REPO_ROOT for privileged admin actions"

# Optional: file tripwire (live ops/whitelist + server .env) if inotify is present.
if command -v inotifywait >/dev/null 2>&1; then
  ( inotifywait -m -e modify,create,move,delete --format '%w%f %e' \
        "$REPO_ROOT/apps/server/server-data/ops.json" \
        "$REPO_ROOT/apps/server/server-data/whitelist.json" \
        "$REPO_ROOT/apps/server/.env" 2>/dev/null \
    | while IFS= read -r line; do alert "file changed: $line"; done ) &
  note "file tripwire armed (ops.json / whitelist.json / .env)"
else
  note "inotifywait not found — file tripwire disabled (log tripwire still active)"
fi

# Log tripwire: reattach across container restarts so a restart can't blind it.
while true; do
  docker logs -f --since 1s "$CONTAINER" 2>&1 \
    | sed -u 's/\x1b\[[0-9;]*m//g' \
    | grep --line-buffered -iE "$LOG_PATTERN" \
    | while IFS= read -r line; do alert "${line#*]: }"; done
  note "log stream ended (container restart?) — reattaching in 3s"
  sleep 3
done
