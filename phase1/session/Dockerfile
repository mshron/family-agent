# Session container: pi in RPC mode with full tools.
# Phase 1 runs unhardened by design (see docs/memos/hetzner-consolidation.md,
# Phase 1 — Feel test). Hardening arrives in Phase 2.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @earendil-works/pi-coding-agent@1.0.0

RUN git config --global user.name "pi (family-agent)" \
 && git config --global user.email "pi@family-agent.local" \
 && git config --global init.defaultBranch main \
 && git config --global safe.directory '*'

# pi home: settings, search MCP, auto virtual model.
COPY home/ /root/.pi/agent/
COPY extensions/auto-router.ts /root/.pi/agent/extensions/auto-router.ts
COPY mcp/search-server.js /opt/pi-mcp/search-server.js

WORKDIR /workspace
ENTRYPOINT ["pi"]
