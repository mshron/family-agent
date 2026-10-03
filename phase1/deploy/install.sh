#!/usr/bin/env bash
# On-box installer. Run on the session box after rsync:
#   cd /opt/family-agent && bash phase1/deploy/install.sh
set -euo pipefail
cd /opt/family-agent

if [ ! -f .env ]; then
  echo "ERROR: /opt/family-agent/.env is missing (push secrets first)" >&2
  exit 1
fi
source .env

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required (apt-get install -y jq)" >&2
  exit 1
fi

# Channels come from channels.json, the same file the gateway reads.
CHANNELS_FILE="phase1/channels.json"
mapfile -t STREAMS < <(jq -r '.streams[]' "$CHANNELS_FILE")

# One workspace repo per channel (once), plus "dm" for direct messages.
# meta is special: its workspace is a clone of the system repo, not the
# skeleton (see the README before wiring it up).
for s in "${STREAMS[@]}" dm; do
  if [ "$s" = "meta" ] && [ -n "${META_REMOTE_URL:-}" ] && [ ! -d "workspaces/meta/.git" ]; then
    git clone "$META_REMOTE_URL" workspaces/meta
    echo "meta workspace cloned from $META_REMOTE_URL"
    continue
  fi
  if [ ! -d "workspaces/$s/.git" ]; then
    mkdir -p "workspaces/$s"
    cp -r phase1/workspace/. "workspaces/$s/"
    git -C "workspaces/$s" init -q
    git -C "workspaces/$s" add -A
    git -C "workspaces/$s" -c user.name="family-agent install" \
        -c user.email="install@family-agent.local" commit -qm "Initial workspace from skeleton"
    echo "workspace initialized: workspaces/$s"
  fi
done
mkdir -p durable

# Skill layers: read-only for agents, one dir per layer.
mkdir -p skills/global
for s in "${STREAMS[@]}" dm; do mkdir -p "skills/$s"; done

# Push secrets for the meta channel (deploy key + known_hosts), mode 600.
mkdir -p secrets/push

echo "building exec image..."
docker build -q -t family-agent-exec:latest phase1/exec

echo "starting gateway..."
docker compose -f phase1/deploy/docker-compose.yml up -d --build
docker image prune -f >/dev/null
echo "done. logs: docker logs -f fa-gateway"
