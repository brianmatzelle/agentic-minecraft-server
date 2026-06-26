#!/usr/bin/env bash
# ── Garvis auto-deploy watcher ───────────────────────────────────────────────
# Closes the "Garvis is too slow" gap: a friend's mod request becomes a live server
# change WITHOUT waiting for the owner to merge + run deploy.sh by hand — while keeping
# the world and host protected. One pass does:
#
#   1. (if GARVIS_AUTOMERGE=on) merge eligible Garvis mod-add PRs — but ONLY ones whose
#      diff is confined to the mod-list / client-pack files (the allowlist below). A PR
#      that touches code, compose, .env, workflows, or anything else is NEVER auto-merged
#      and still needs a human. This is the supply-chain boundary (see docs/security.md).
#   2. fast-forward local main to origin/main (only if the checkout is clean + on main).
#   3. if the mod files changed since the last deploy, run deploy.sh --health-check, which
#      AUTO-ROLLS-BACK the live server if the new mod set won't boot.
#   4. on a failed deploy, QUARANTINE that commit (never auto-retry it) and ALERT loudly.
#
# It is INERT unless GARVIS_AUTODEPLOY=on, so installing it changes nothing until you opt
# in. Designed to be run periodically by infra/systemd/garvis-auto-deploy.timer (oneshot),
# or manually. It only ever MERGES PRs and DEPLOYS the repo — it never runs the Claude
# agent and never edits the world. Run as the host user that can `docker`, `git`, and `gh`.
#
# Usage:
#   GARVIS_AUTODEPLOY=on GARVIS_AUTOMERGE=on scripts/auto-deploy.sh
#   scripts/auto-deploy.sh --dry-run     # show what it WOULD merge/deploy, change nothing
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="$REPO_ROOT/apps/server/.auto-deploy-state"

AUTODEPLOY="${GARVIS_AUTODEPLOY:-off}"   # master switch — off => this script does nothing
AUTOMERGE="${GARVIS_AUTOMERGE:-off}"     # also auto-merge file-allowlisted mod-add PRs
TIMEOUT="${GARVIS_DEPLOY_TIMEOUT:-420}"  # seconds to wait for boot before rollback
WEBHOOK="${GARVIS_ALERT_WEBHOOK:-}"      # optional Discord webhook for alerts
PR_HEAD_PREFIX="${GARVIS_PR_HEAD_PREFIX:-add-mod/}"  # the agent's mod-add branch convention

# The ONLY files an auto-merged mod-add PR may touch. Anything else => human review.
ALLOWLIST_REGEX='^(apps/agent/modlist\.txt|apps/client/modrinth\.index\.json|apps/client/starting-cc-client\.mrpack)$'

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

ts() { date '+%F %T'; }
log()  { printf '%s [auto-deploy] %s\n' "$(ts)" "$*"; }
# Alert: log + (if configured) post to a Discord webhook. Never fails the script.
alert() {
  local msg="$*"
  printf '%s [auto-deploy] 🚨 %s\n' "$(ts)" "$msg" >&2
  if [ -n "$WEBHOOK" ]; then
    local esc
    esc="$(printf '%s' "🚨 [auto-deploy] $msg" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "auto-deploy alert (see host logs)")"
    curl -fsS -m 10 -H 'Content-Type: application/json' -d "{\"content\": $esc}" "$WEBHOOK" >/dev/null 2>&1 || true
  fi
}

get_state()  { [ -f "$STATE_FILE" ] && grep -E "^$1=" "$STATE_FILE" | head -1 | sed -E "s/^$1=//" || true; }
set_state()  { # set_state KEY VALUE  (atomic-ish rewrite)
  local key="$1" val="$2" tmp; tmp="$(mktemp "${STATE_FILE}.XXXX")"
  { [ -f "$STATE_FILE" ] && grep -vE "^$key=" "$STATE_FILE"; printf '%s=%s\n' "$key" "$val"; } > "$tmp" 2>/dev/null
  mv "$tmp" "$STATE_FILE"
}

if [ "$AUTODEPLOY" != "on" ]; then
  log "GARVIS_AUTODEPLOY!=on — nothing to do (set it to 'on' to enable)."
  exit 0
fi

cd "$REPO_ROOT"
log "fetching origin…"
git fetch --quiet origin || { alert "git fetch failed"; exit 1; }

# ── 1. Auto-merge eligible mod-add PRs (file-allowlisted) ────────────────────
if [ "$AUTOMERGE" = "on" ]; then
  if ! command -v gh >/dev/null 2>&1; then
    log "gh not found — skipping auto-merge."
  else
    # Open PRs whose head branch is the agent's mod-add convention.
    prs="$(gh pr list --state open --base main --json number,headRefName,files \
            --jq ".[] | select(.headRefName | startswith(\"$PR_HEAD_PREFIX\")) | .number" 2>/dev/null || true)"
    for n in $prs; do
      files="$(gh pr view "$n" --json files --jq '.files[].path' 2>/dev/null || true)"
      [ -z "$files" ] && { log "PR #$n: could not read files — skipping."; continue; }
      ineligible="$(printf '%s\n' "$files" | grep -vE "$ALLOWLIST_REGEX" || true)"
      if [ -n "$ineligible" ]; then
        log "PR #$n: touches non-allowlisted files (needs human review): $(printf '%s' "$ineligible" | tr '\n' ' ')"
        continue
      fi
      if [ "$DRY_RUN" -eq 1 ]; then
        log "[dry-run] would auto-merge PR #$n (mod-list/client-pack only)."
      else
        log "auto-merging PR #$n (mod-list/client-pack only)…"
        if gh pr merge "$n" --squash --delete-branch >/dev/null 2>&1; then
          log "merged PR #$n."
        else
          alert "failed to merge PR #$n (branch protection? conflicts?) — needs a human."
        fi
      fi
    done
    git fetch --quiet origin || true
  fi
fi

# ── 2. Deploy if origin/main advanced with mod-file changes ──────────────────
HEAD_REMOTE="$(git rev-parse origin/main)"
LAST_DEPLOYED="$(get_state last_deployed_sha)"
QUARANTINE="$(get_state quarantine_sha)"

if [ "$HEAD_REMOTE" = "${LAST_DEPLOYED:-}" ]; then
  log "origin/main ($HEAD_REMOTE) already deployed — nothing to do."
  exit 0
fi
if [ "$HEAD_REMOTE" = "${QUARANTINE:-}" ]; then
  alert "origin/main ($HEAD_REMOTE) is QUARANTINED (a prior deploy of it failed to boot). Awaiting a manual fix — not auto-retrying."
  exit 0
fi

# Only the mod-list / client-pack files should trigger an auto-deploy. Code/compose/etc.
# changes reach main only via human merge, and a human deploys those.
base="${LAST_DEPLOYED:-HEAD}"
changed="$(git diff --name-only "$base" "$HEAD_REMOTE" 2>/dev/null || git diff --name-only HEAD "$HEAD_REMOTE")"
if ! printf '%s\n' "$changed" | grep -qE "$ALLOWLIST_REGEX"; then
  log "origin/main advanced but no mod-list/client-pack change — leaving non-mod changes for a human deploy."
  [ "$DRY_RUN" -eq 1 ] && { log "[dry-run] would mark $HEAD_REMOTE as seen."; exit 0; }
  set_state last_deployed_sha "$HEAD_REMOTE"   # don't keep re-checking the same commit
  exit 0
fi

# Safe to touch the live checkout only if it's clean and on main (don't clobber WIP).
branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ] || [ -n "$(git status --porcelain)" ]; then
  log "checkout is not a clean 'main' (on '$branch', $(git status --porcelain | wc -l) dirty) — skipping deploy this pass."
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] would fast-forward main to $HEAD_REMOTE and run deploy.sh --health-check --timeout $TIMEOUT"
  exit 0
fi

log "fast-forwarding main to $HEAD_REMOTE and deploying…"
git merge --ff-only origin/main || { alert "could not fast-forward main (diverged?) — skipping."; exit 1; }

if "$REPO_ROOT/scripts/deploy.sh" --health-check --timeout "$TIMEOUT"; then
  set_state last_deployed_sha "$HEAD_REMOTE"
  set_state last_result ok
  log "✅ deployed $HEAD_REMOTE and the server booted clean."
  [ -n "$WEBHOOK" ] && alert "✅ Deployed new mods live ($HEAD_REMOTE) — server is up." || true
else
  # deploy.sh already rolled the LIVE server back to the previous (good) mod set.
  set_state quarantine_sha "$HEAD_REMOTE"
  set_state last_result failed
  alert "Deploy of $HEAD_REMOTE FAILED to boot — the live server was auto-rolled-back to the previous mods. That commit is quarantined; a human needs to fix the mod (e.g. pin a compatible version) and push a new commit."
fi
