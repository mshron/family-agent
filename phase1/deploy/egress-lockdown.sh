#!/usr/bin/env bash
# Egress lockdown for exec containers (Phase 2). OPERATOR-RUN, never invoked
# by a deploy: activating it changes what sessions can reach, and it must be
# run with a human watching that sessions still work (npm/pip install still
# resolve, uploads still fetch). Default state: NOT ACTIVE.
#
# What it does: installs rules in Docker's DOCKER-USER chain so containers
# may reach only DNS, the package registries, and (optionally) the gateway
# box. Everything else — arbitrary internet, exfiltration endpoints — is
# dropped. The registries resolve to CDN IPs; the script re-resolves at run
# time, so re-run it after boot or IP changes (a systemd unit or cron entry
# belongs on the box when this becomes the default).
#
# Usage:
#   bash egress-lockdown.sh on  [GATEWAY_IP]   # apply rules
#   bash egress-lockdown.sh off                # remove rules
#   bash egress-lockdown.sh status             # show what is applied
#
# Notes:
# - Rules apply to ALL docker containers on the host, including the gateway
#   container. The gateway needs Zulip + OpenRouter + search APIs — pass
#   GATEWAY_IP only when the gateway lives on its own box; on a single box
#   the gateway needs full egress, so "on" without the split means allowing
#   the gateway's destinations too (see ALLOW_EXTRA_HOSTS).
# - Set ALLOW_EXTRA_HOSTS (space-separated) before "on" to extend the list.

set -euo pipefail

CHAIN=DOCKER-USER
MARK=family-agent-egress
REGISTRY_HOSTS="registry.npmjs.org pypi.org files.pythonhosted.org"

rule_spec() { echo "-m comment --comment $MARK"; }

rules_applied() {
  iptables -C "$CHAIN" -m comment --comment "$MARK" -j REJECT >/dev/null 2>&1
}

apply_rules() {
  local gateway_ip="${1:-}"
  local extra_hosts="${ALLOW_EXTRA_HOSTS:-}"

  if ! iptables -L "$CHAIN" >/dev/null 2>&1; then
    echo "ERROR: $CHAIN chain not found — docker must be running" >&2
    exit 1
  fi

  # Order matters: allow first, reject everything else last.
  local args=()
  # Established/related back in.
  iptables -I "$CHAIN" 1 -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment "$MARK" -j RETURN
  # DNS (host resolver forwards from docker bridge; allow both ports).
  iptables -I "$CHAIN" 2 -p udp --dport 53 -m comment --comment "$MARK" -j RETURN
  iptables -I "$CHAIN" 3 -p tcp --dport 53 -m comment --comment "$MARK" -j RETURN
  local idx=4
  for host in $REGISTRY_HOSTS $extra_hosts; do
    for ip in $(getent hosts "$host" | awk '{print $1}' | sort -u); do
      iptables -I "$CHAIN" "$idx" -d "$ip" -m comment --comment "$MARK" -j RETURN
      idx=$((idx + 1))
      echo "  allow $host ($ip)"
    done
  done
  if [ -n "$gateway_ip" ]; then
    iptables -I "$CHAIN" "$idx" -d "$gateway_ip" -m comment --comment "$MARK" -j RETURN
    idx=$((idx + 1))
    echo "  allow gateway box ($gateway_ip)"
  fi
  iptables -I "$CHAIN" "$idx" -m comment --comment "$MARK" -j REJECT
  echo "egress lockdown ON ($idx rules). Test a session before walking away."
}

remove_rules() {
  local n=0
  while iptables -D "$CHAIN" -m comment --comment "$MARK" -j RETURN >/dev/null 2>&1; do n=$((n+1)); done
  while iptables -D "$CHAIN" -m comment --comment "$MARK" -j REJECT >/dev/null 2>&1; do n=$((n+1)); done
  # Catch rules with a -d match written by earlier versions of this script.
  while iptables -L "$CHAIN" --line-numbers -n 2>/dev/null | awk -v m="$MARK" '$0 ~ m {print $1}' | head -1 | grep -q .; do
    local line
    line=$(iptables -L "$CHAIN" --line-numbers -n | awk -v m="$MARK" '$0 ~ m {print $1}' | head -1)
    iptables -D "$CHAIN" "$line"
    n=$((n+1))
  done
  echo "egress lockdown OFF (removed $n rules)."
}

case "${1:-}" in
  on)
    rules_applied && { echo "already on"; exit 0; }
    apply_rules "${2:-}"
    ;;
  off)
    remove_rules
    ;;
  status)
    if rules_applied; then echo "on"; else echo "off"; fi
    iptables -L "$CHAIN" -n 2>/dev/null | grep "$MARK" || true
    ;;
  *)
    echo "usage: $0 on [GATEWAY_IP] | off | status" >&2
    exit 1
    ;;
esac