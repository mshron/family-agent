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

# One workspace repo per channel (once). Single user memory per channel for
# now; shared-user-memory promotion is a Phase 2+ decision.
STREAMS="${SCRATCH_STREAM:-scratch}"
for s in $STREAMS; do
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

echo "building exec image..."
docker build -q -t family-agent-exec:latest phase1/exec

echo "starting gateway..."
docker compose -f phase1/deploy/docker-compose.yml up -d --build
docker image prune -f >/dev/null
echo "done. logs: docker logs -f fa-gateway"
