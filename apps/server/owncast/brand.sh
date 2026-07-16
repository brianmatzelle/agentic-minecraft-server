#!/bin/bash
# Garvis TV branding for the Owncast page at https://tv.starting.cc
#
# Owncast branding (name, about text, logo, theme colors, custom CSS) is
# CONFIG-STATE living in the owncast-data volume — not files, not env. This
# script is the repo's source of truth for it: idempotent, re-run any time
# (e.g. after a volume wipe). Requires OWNCAST_ADMIN_PASSWORD in ../.env and
# the container up on 127.0.0.1:8088.
#
# Applied 2026-07-16. Verified landmines, should you edit the theme:
#   * appearance vars are injected by the frontend as INLINE :root properties,
#     so they beat any stylesheet — use them for colors, customstyles for the
#     rest. Keys are the page's --theme-* CSS variables minus the leading "--".
#   * theme-color-components-text-on-light is consumed on surfaces this theme
#     turns DARK (the about section) — it must stay light, despite the name.
#   * the chat input ignores the form-field-text var (Ant default
#     rgba(0,0,0,.85) wins) — the ChatTextField rule below fixes that; without
#     it, typed chat is invisible on the dark background.
set -euo pipefail
cd "$(dirname "$0")"
export $(grep -E "^OWNCAST_ADMIN_PASSWORD=" ../.env | head -1)
OC="${OWNCAST_URL:-http://127.0.0.1:8088}"

post() { # post <endpoint> <json-on-stdin>
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -u "admin:$OWNCAST_ADMIN_PASSWORD" \
    -H 'Content-Type: application/json' -X POST --data-binary @- "$OC/api/admin/config/$1")
  echo "[$code] $1"
  [ "$code" = "200" ] || { echo "  ^^ FAILED" >&2; exit 1; }
}

post name <<'EOF'
{"value": "Garvis TV"}
EOF

post serversummary <<'EOF'
{"value": "Live from the Cobblemon server — Garvis's first-person POV, 24/7. Game audio on. Say hi in chat."}
EOF

# About section under the player (markdown).
post pagecontent <<'EOF'
{"value": "## This is Garvis\n\n**Garvis** is the AI that maintains — and now *plays* — the starting.cc Minecraft server. You're watching his real first-person view: a modded client walking the world on its own, game audio and all.\n\n## Talk to the world\n\nAnything you type in chat shows up **inside the game** — players see you as 📺. Be nice.\n\n## Command him\n\nGarvis takes commands from the stream:\n\n1. Grab a credit code at the [🎟️ tollbooth](/tollbooth)\n2. Redeem it in chat: `!redeem YOUR-CODE`\n3. Spend away: `!g mine some iron` · `!g follow <player>` · `!g put a creeper on the TV` · `!g spectate <player>` — `!balance` and `!help` are free.\n\nThe world lives at `mc.starting.cc` (whitelisted friends). The stadium jumbotron you'll sometimes see on screen is this same camera — Garvis watching himself."}
EOF

post offlinemessage <<'EOF'
{"value": "Garvis is off the air — probably asleep in a portable bed. The camera relights itself; check back in a bit."}
EOF

post welcomemessage <<'EOF'
{"value": "📺 you are on GARVIS TV — chat lands inside the game. type !help for commands."}
EOF

post tags <<'EOF'
{"value": ["minecraft", "cobblemon", "ai", "garvis"]}
EOF

post socialhandles <<'EOF'
{"value": []}
EOF

# CRT-TV mark (sibling logo.svg), uploaded as a base64 data URL.
printf '{"value": "data:image/svg+xml;base64,%s"}' "$(base64 -w0 logo.svg)" | post logo

# Theme: GitHub-dark surfaces + Minecraft-green action color.
post appearance <<'EOF'
{"value": {
  "theme-color-background-main": "#0d1117",
  "theme-color-background-header": "#010409",
  "theme-color-action": "#3fb950",
  "theme-color-action-hover": "#56d364",
  "theme-color-components-content-background": "#161b22",
  "theme-color-components-chat-background": "#0d1117",
  "theme-color-components-chat-text": "#e6edf3",
  "theme-color-components-text-on-dark": "#e6edf3",
  "theme-color-components-text-on-light": "#e6edf3",
  "theme-color-components-form-field-background": "#161b22",
  "theme-color-components-form-field-text": "#e6edf3",
  "theme-color-components-form-field-placeholder": "#8b949e",
  "theme-color-components-primary-button-background": "#238636",
  "theme-color-components-primary-button-text": "#ffffff",
  "theme-color-components-primary-button-border": "#2ea043",
  "theme-color-components-video-status-bar-background": "#010409",
  "theme-color-components-video-status-bar-foreground": "#e6edf3",
  "theme-color-components-video-live-indicator": "#f85149",
  "theme-color-components-menu-background": "#161b22",
  "theme-color-components-menu-item-focus-bg": "#21262d",
  "theme-color-components-modal-header-background": "#161b22",
  "theme-color-components-modal-header-text": "#e6edf3",
  "theme-color-palette-0": "#21262d",
  "theme-color-palette-3": "#30363d",
  "theme-color-palette-4": "#161b22",
  "theme-color-palette-12": "#58a6ff",
  "theme-rounded-corners": "8px"
}}
EOF

# What variables can't reach: hide the Owncast footer, fix the chat input's
# Ant-default text color, darken Ant popup surfaces, green system bubble.
post customstyles <<'EOF'
{"value": "footer#footer { display: none !important; } .global-header { border-bottom: 1px solid #21262d; } [class*=ChatTextField] , [class*=ChatTextField] [contenteditable] { color: #e6edf3 !important; caret-color: #e6edf3; } [class*=ChatTextField] [contenteditable]:empty:before { color: #8b949e; } .ant-popover-inner, .ant-dropdown-menu, .ant-modal-content, .ant-drawer-content { background-color: #161b22 !important; color: #e6edf3; } .ant-modal-body, .ant-popover-inner-content { color: #e6edf3; } [class*=ChatSystemMessage_chatSystemMessage] { background: linear-gradient(70deg, #238636, #196c2e 80%) !important; }"}
EOF

echo "done — https://tv.starting.cc"
