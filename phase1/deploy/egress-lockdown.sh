#!/usr/bin/env bash
# Egress lockdown for the session box (Phase 2). OPERATOR-RUN, never invoked
# by a deploy: activating it changes what containers can reach, and it must
# be applied with a live session watched (npm/pip still resolve, pushes
# still push, the gateway still reaches Zulip and the vault proxy).
# Default state: NOT ACTIVE.
#
# What it does: rules in Docker's DOCKER-USER chain (IPv4 and IPv6 — the
# box has global IPv6, so v4-only rules would leave a second door open) so
# containers may reach only:
#   - DNS
#   - the package/image registries that builds and installs need
#     (Docker Hub, Debian, Docker's apt repo, npm, PyPI — plus anything
#     in ALLOW_EXTRA_HOSTS)
#   - the IPs in ALLOW_EXTRA_IPS (default: the vault proxy and the mark
#     sidecar's on-host Tailscale address)
# Everything else — arbitrary internet, exfiltration endpoints — is
# dropped. Host processes (deploys, git fetch on the host) are unaffected;
# only container-originated traffic traverses DOCKER-USER.
#
# Usage:
#   ALLOW_EXTRA_HOSTS="h1 h2" ALLOW_EXTRA_IPS="10.0.0.4" \
#     bash egress-lockdown.sh on
#   bash egress-lockdown.sh off
#   bash egress-lockdown.sh status
#
# Notes:
# - Applies to ALL containers on the host, including LibreChat's
#   sandbox-runner (deferred, still on this box). If it needs outbound
#   access beyond this list, add its destinations to ALLOW_EXTRA_HOSTS.
# - Registry IPs are CDN-resolved at run time; re-run after boot or IP
#   changes (a cron entry belongs on the box when this becomes default).

set -euo pipefail

CHAIN=DOCKER-USER
MARK=family-agent-egress
REGISTRY_HOSTS="registry.npmjs.org pypi.org files.pythonhosted.org registry-1.docker.io auth.docker.io deb.debian.org download.docker.com"
DEFAULT_EXTRA_IPS="10.0.0.4 100.104.80.107"

rule_spec() { echo "-m comment --comment $MARK"; }

rules_applied() {
  iptables -C "$CHAIN" -m comment --comment "$MARK" -j REJECT >/dev/null 2>&1
}

# add_for_family <iptables|ip6tables> <label> — builds the allow list for
# one address family. Hostnames resolve per-family at rule-build time.
add_for_family() {
  local ipt="$1" hosts="${ALLOW_EXTRA_HOSTS:-}" ips="${ALLOW_EXTRA_IPS:-$DEFAULT_EXTRA_IPS}"
  local idx=1
  local resolve
  if [ "$ipt" = iptables ]; then resolve="getent ahostsv4"; else resolve="getent ahostsv6"; fi

  $ipt -I "$CHAIN" $idx -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment "$MARK" -j RETURN
  idx=$((idx + 1))
  $ipt -I "$CHAIN" $idx -p udp --dport 53 -m comment --comment "$MARK" -j RETURN
  idx=$((idx + 1))
  $ipt -I "$CHAIN" $idx -p tcp --dport 53 -m comment --comment "$MARK" -j RETURN
  idx=$((idx + 1))
  # Docker's embedded DNS (127.0.0.11) proxies to the host resolver; some
  # images query external resolvers directly, hence the 53 rules above.
  local host ip
  for host in $REGISTRY_HOSTS $hosts; do
    for ip in $($resolve "$host" 2>/dev/null | awk '{print $1}' | sort -u); do
      $ipt -I "$CHAIN" $idx -d "$ip" -m comment --comment "$MARK" -j RETURN
      idx=$((idx + 1))
      echo "  allow $host ($ip) [$ipt]"
    done
  done
  for ip in $ips; do
    # Skip addresses that do not belong to this family (10.0.0.4 is not an
    # ip6tables destination; ::ffff: forms are not iptables destinations).
    if [ "$ipt" = ip6tables ] && [ "${ip#*:}" = "$ip" ]; then continue; fi
    if [ "$ipt" = iptables ] && [ "${ip#*:}" != "$ip" ]; then continue; fi
    $ipt -I "$CHAIN" $idx -d "$ip" -m comment --comment "$MARK" -j RETURN
    idx=$((idx + 1))
    echo "  allow ip $ip [$ipt]"
  done
  $ipt -I "$CHAIN" $idx -m comment --comment "$MARK" -j REJECT
  echo "  [$ipt] reject everything else ($idx rules)"
}

apply_rules() {
  if ! iptables -L "$CHAIN" >/dev/null 2>&1; then
    echo "ERROR: $CHAIN chain not found — docker must be running" >&2
    exit 1
  fi
  add_for_family iptables
  if command -v ip6tables >/dev/null 2>&1 && ip6tables -L "$CHAIN" >/dev/null 2>&1; then
    add_for_family ip6tables
  fi
  echo "egress lockdown ON. Test a live session before walking away."
}

remove_rules() {
  local n=0
  for ipt in iptables ip6tables; do
    command -v "$ipt" >/dev/null 2>&1 || continue
    while $ipt -D "$CHAIN" -m comment --comment "$MARK" -j RETURN >/dev/null 2>&1; do n=$((n + 1)); done
    while $ipt -D "$CHAIN" -m comment --comment "$MARK" -j REJECT >/dev/null 2>&1; do n=$((n + 1)); done
    # Catch rules with a -d match written by earlier versions of this script.
    while $ipt -L "$CHAIN" --line-numbers -n 2>/dev/null | awk -v m="$MARK" '$0 ~ m {print $1}' | head -1 | grep -q .; do
      local line
      line=$($ipt -L "$CHAIN" --line-numbers -n | awk -v m="$MARK" '$0 ~ m {print $1}' | head -1)
      $ipt -D "$CHAIN" "$line"
      n=$((n + 1))
    done
  done
  echo "egress lockdown OFF (removed $n rules)."
}

case "${1:-}" in
  on)
    rules_applied && { echo "already on"; exit 0; }
    apply_rules
    ;;
  off)
    remove_rules
    ;;
  status)
    if rules_applied; then echo "on"; else echo "off"; fi
    iptables -L "$CHAIN" -n 2>/dev/null | grep "$MARK" || true
    ip6tables -L "$CHAIN" -n 2>/dev/null | grep "$MARK" || true
    ;;
  *)
    echo "usage: $0 on | off | status" >&2
    echo "  env: ALLOW_EXTRA_HOSTS (space-separated), ALLOW_EXTRA_IPS (default: $DEFAULT_EXTRA_IPS)" >&2
    exit 1
    ;;
esac
