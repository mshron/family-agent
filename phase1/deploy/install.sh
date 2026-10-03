#!/usr/bin/env bash
# On-box installer. Run on the session box after rsync:
#   cd /opt/family-agent && bash phase1/deploy/install.sh
set -euo pipefail
cd /opt/family-agent

if [ ! -f .env ]; then
  echo "ERROR: /opt/family-agent/.env is missing (push secrets first)" >&2
  exit 1
fi

# Workspace repo from skeleton (once).
if [ ! -d workspace/.git ]; then
  mkdir -p workspace
  cp -r phase1/workspace/. workspace/
  git -C workspace init -q
  git -C workspace add -A
  git -C workspace -c user.name="family-agent install" \
      -c user.email="install@family-agent.local" commit -qm "Initial workspace from skeleton"
  echo "workspace initialized"
fi
mkdir -p sessions

echo "building session image..."
docker build -q -t family-agent-session:latest phase1/session

echo "starting gateway..."
docker compose -f phase1/deploy/docker-compose.yml up -d --build
docker image prune -f >/dev/null
echo "done. logs: docker logs -f fa-gateway"
