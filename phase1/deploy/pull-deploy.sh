#!/usr/bin/env bash
# On-box redeploy, run by CI/CD (GitHub Actions) or by hand.
#
# The deployed tree at /opt/family-agent/phase1 is rsynced from the repo
# clone at /opt/family-agent/workspaces/meta (the #meta channel's workspace),
# so an agent in #meta can: edit code, commit, push_changes (deploy key),
# and CI picks it up and runs this script. /opt/family-agent/.env, the
# workspaces, durable store, skills, and secrets are outside the rsync
# target and are never touched.
set -euo pipefail

REPO=/opt/family-agent/workspaces/meta
DEST=/opt/family-agent/phase1

if [ ! -d "$REPO/.git" ]; then
  echo "ERROR: $REPO is not a git clone. See phase1/README.md (#meta channel)." >&2
  exit 1
fi

cd "$REPO"
git fetch origin
git reset --hard origin/main

echo "rsyncing phase1/ -> $DEST"
rsync -a --delete --exclude .git ./phase1/ "$DEST/"

cd /opt/family-agent
if [ ! -f .env ]; then
  echo "ERROR: /opt/family-agent/.env is missing" >&2
  exit 1
fi

bash phase1/deploy/install.sh
echo "deploy complete."
