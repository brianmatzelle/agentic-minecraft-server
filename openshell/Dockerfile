# Custom long-lived agent image for OpenShell (Layer 5).
# Requirements that are [VERIFIED] for OpenShell BYOC:
#   - non-root user `sandbox` at uid/gid 1000660000
#   - iproute2 present; writable /sandbox; NOT distroless/scratch
#   - the OpenShell supervisor REPLACES this CMD at runtime (start cmd passed after `--`)
# [ILLUSTRATIVE]: base image + the hermes install line — confirm Hermes' real install method.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl git iproute2 nftables ca-certificates jq \
    && rm -rf /var/lib/apt/lists/*

# The agent's brain. Package name is [VERIFIED].
RUN npm install -g @anthropic-ai/claude-code

# Hermes Agent — [ILLUSTRATIVE] install; replace with the method from its README
# (pip/npm/git) and PIN a version. e.g.:  RUN pipx install hermes-agent==<ver>
# RUN <install hermes-agent here>

# Non-root sandbox user — uid/gid are [VERIFIED] required values.
RUN groupadd -g 1000660000 sandbox \
    && useradd -m -u 1000660000 -g sandbox sandbox \
    && install -d -o sandbox -g sandbox /sandbox
USER sandbox
WORKDIR /sandbox

# Confirm tool locations match openshell/policy.yaml `binaries[].path`:
#   docker run --rm <img> sh -c 'which git curl gh node claude'
CMD ["hermes", "serve"]   # replaced by the `--` command at sandbox create time
