#!/usr/bin/env bash
# Vault box: fetch the reviewed proxy config from the (public) repo and
# restart the proxy if it changed. The Caddyfile is reviewed in-repo like
# code; this box never invents configuration at 2am. Cron runs this every
# 15 minutes (installed by bootstrap.sh).
set -euo pipefail

DIR=/opt/family-agent/phase1/deploy/proxy
REPO=https://github.com/mshron/family-agent
BRANCH=main

mkdir -p "$DIR"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$REPO/archive/$BRANCH.tar.gz" \
  | tar -xz -C "$tmp" --strip-components=1 \
  --wildcards '*/phase1/deploy/proxy/Caddyfile' '*/phase1/deploy/proxy/compose.yml'

changed=0
for f in Caddyfile compose.yml; do
  if [ ! -f "$DIR/$f" ] || ! cmp -s "$tmp/phase1/deploy/proxy/$f" "$DIR/$f"; then
    install -m 644 "$tmp/phase1/deploy/proxy/$f" "$DIR/$f"
    echo "updated $f"
    changed=1
  fi
done
[ "$changed" = 1 ] && cd /opt/family-agent && docker compose -f phase1/deploy/proxy/compose.yml up -d
exit 0
