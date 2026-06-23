#!/bin/bash
# PreToolUse backstop on Bash — hard-blocks downloaders/installers BEFORE permission
# rules evaluate. `exit 2` = hard block (JSON ignored). Register as a PreToolUse hook
# on the Bash tool; protect it with managed `allowManagedHooksOnly: true`.
# Mechanism + exit-2 semantics are [VERIFIED]. This is a backstop, NOT the primary
# boundary — the OpenShell egress sandbox is the real exfil/supply-chain control.
cmd=$(jq -r '.tool_input.command' < /dev/stdin)
if echo "$cmd" | grep -qE '\b(curl|wget|npm install|pip install|pipx install|git push)\b'; then
  echo "Blocked: downloaders/installers/push are not permitted (supply-chain + deploy gate)." >&2
  exit 2
fi
exit 0
