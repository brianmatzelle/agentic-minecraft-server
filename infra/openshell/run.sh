#!/usr/bin/env bash
# Stand up the egress-sandboxed maintenance agent (Layer 5), then keep it alive so
# Garvis can `openshell sandbox exec` mod-install tasks into it.
#
# Verified against the installed OpenShell CLI:
#   - `sandbox create --from <Dockerfile|dir>` BUILDS the image locally, then creates.
#   - `--policy <file>` applies the egress allowlist at create time.
#   - the command after `--` replaces the image CMD; `sleep infinity` = long-lived box.
#   - `sandbox exec -n <name> --workdir <dir> -- <cmd>` runs a command inside it.
set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-mc-maint-agent}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_URL="${REPO_URL:-https://github.com/brianmatzelle/agentic-minecraft-server.git}"

# 1) Register a local gateway (once per host; ignore error if it already exists).
openshell gateway add http://127.0.0.1:8080 --local --name local 2>/dev/null || true

# 2) Build the image + create the long-lived sandbox with the egress policy applied.
openshell sandbox create \
    --name "${SANDBOX_NAME}" \
    --from "${HERE}/Dockerfile" \
    --policy "${HERE}/policy.yaml" \
    -- sleep infinity

# 3) Inject credentials the agent needs (NOT the Discord token):
#    - gh auth (token) so it can push branches + open PRs
#    - claude auth so the agent can run
#    Upload happens host->sandbox; paths assume the sandbox 'sandbox' user's $HOME.
openshell sandbox upload "${SANDBOX_NAME}" "${HOME}/.config/gh/hosts.yml" /sandbox/.config/gh/hosts.yml
openshell sandbox upload "${SANDBOX_NAME}" "${HOME}/.claude/.credentials.json" /sandbox/.claude/.credentials.json

# 4) Clone the repo into the sandbox's only writable state (/sandbox). The agent
#    works here; egress to github.com is allow-listed by policy.yaml.
openshell sandbox exec -n "${SANDBOX_NAME}" --workdir /sandbox -- \
    git clone "${REPO_URL}" /sandbox/minecraft

# 5) Sanity check: tools resolve + egress to Modrinth works through the allowlist.
openshell sandbox exec -n "${SANDBOX_NAME}" -- sh -lc \
    'command -v git gh node claude curl zip; curl -s -o /dev/null -w "modrinth:%{http_code}\n" https://api.modrinth.com/v2/project/cobblemon'

echo "Sandbox '${SANDBOX_NAME}' is up with the repo cloned at /sandbox/minecraft."
echo "Point the bot at it:  GARVIS_DISPATCH_MODE=openshell  OPENSHELL_SANDBOX=${SANDBOX_NAME}  OPENSHELL_WORKDIR=/sandbox/minecraft"
echo "KILL SWITCH:          openshell sandbox delete ${SANDBOX_NAME}"
