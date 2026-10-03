#!/usr/bin/env bash
# Install a skill into a read-only skill layer.
#
#   skills/install.sh <git-url-or-local-path> [--global | --channel NAME]
#
# A skill is a directory containing SKILL.md (frontmatter: name,
# description). Installed skills appear to every agent in the layer's scope
# as a read-only path (/skills/<name> globally, /channel-skills/<name> per
# channel); agents read them with the read tool. Changes need a gateway
# restart only when adding/removing skills, not when editing their files.
set -euo pipefail

usage() { echo "usage: $0 <git-url-or-local-path> [--global | --channel NAME]" >&2; exit 1; }

[ $# -ge 1 ] || usage
SRC="$1"; shift
SCOPE="global"; CHANNEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --global) SCOPE="global" ;;
    --channel) shift; [ -n "${1:-}" ] || usage; CHANNEL="$1" ;;
    *) usage ;;
  esac
  shift
done
[ "$SCOPE" = "global" ] || [ -n "$CHANNEL" ] || usage

BASE="$(cd "$(dirname "$0")" && pwd)"    # /opt/family-agent/phase1/skills
ROOT="$(cd "$BASE/../.." && pwd)"          # /opt/family-agent
DEST="$ROOT/skills/global"
[ "$SCOPE" = "channel" ] && DEST="$ROOT/skills/$CHANNEL"
mkdir -p "$DEST"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -d "$SRC" ]; then
  NAME="$(basename "$SRC")"
  cp -r "$SRC" "$TMP/$NAME"
elif git ls-remote "$SRC" >/dev/null 2>&1; then
  git clone -q --depth 1 "$SRC" "$TMP/clone"
  NAME="$(basename "$SRC" .git)"
  mv "$TMP/clone" "$TMP/$NAME"
else
  echo "ERROR: not a local dir or git URL: $SRC" >&2; exit 1
fi

if [ ! -f "$TMP/$NAME/SKILL.md" ]; then
  echo "ERROR: $NAME has no SKILL.md at its root" >&2; exit 1
fi

rm -rf "$DEST/$NAME"
mv "$TMP/$NAME" "$DEST/$NAME"
echo "installed skill '$NAME' -> $DEST/$NAME"
echo "restart the gateway if agents are running: docker restart fa-gateway"
