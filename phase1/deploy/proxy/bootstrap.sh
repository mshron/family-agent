#!/usr/bin/env bash
# One-time bootstrap for the vault box (the trusted half of the two-box
# split). Idempotent; safe to re-run. Run as root on a fresh Ubuntu 22.04+
# Hetzner box attached to the 10.0.0.0/16 private network as 10.0.0.4.
#
# What this box is: the credential proxy (all upstream keys), endpoint
# monitoring (auditd, AIDE, central syslog), and the backup target for the
# session box. Nothing else. No sessions, no exec containers, no docker.sock
# mounts, no user code. Any change here is signal.
#
# Requires before running: /opt/family-agent/proxy.env (keys, mode 600) and
# the Caddyfile + compose.yml from phase1/deploy/proxy/ in place.
set -euo pipefail

SESSION_BOX_IP=10.0.0.3   # the box running fa-gateway and exec containers
PRIVATE_IP=10.0.0.4

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 auditd aide rsyslog >/dev/null

# Firewall: SSH from anywhere (key-only auth), the proxy and syslog ports
# from the session box only, established traffic back, everything else
# dropped. ADDITIVE INPUT rules only — never iptables-restore the whole
# filter table here, that wipes Docker's chains and breaks networking.
# The INPUT chain is ours alone (flush + rebuild); FORWARD/OUTPUT and all
# IPv6 forwarding stay as Docker wants them.
cat > /usr/local/sbin/family-agent-firewall <<EOF
#!/usr/bin/env bash
set -euo pipefail
for ipt in iptables ip6tables; do
  command -v "\$ipt" >/dev/null || continue
  "\$ipt" -F INPUT
  "\$ipt" -A INPUT -i lo -j ACCEPT
  "\$ipt" -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  "\$ipt" -A INPUT -p tcp --dport 22 -j ACCEPT
  "\$ipt" -A INPUT -p tcp -s $SESSION_BOX_IP --dport 8080 -j ACCEPT
  "\$ipt" -A INPUT -p tcp -s $SESSION_BOX_IP --dport 3128 -j ACCEPT
  "\$ipt" -A INPUT -p tcp -s $SESSION_BOX_IP --dport 514 -j ACCEPT
  "\$ipt" -P INPUT DROP
done
EOF
chmod +x /usr/local/sbin/family-agent-firewall
mkdir -p /etc/systemd/system
cat > /etc/systemd/system/family-agent-firewall.service <<'EOF'
[Unit]
Description=family-agent vault firewall rules
Before=docker.service
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/family-agent-firewall
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
EOF
systemctl enable --now family-agent-firewall.service >/dev/null 2>&1 || true
systemctl restart docker.service   # rebuild the chains the first restore clobbered, if any

# rsyslog: receive the session box's logs (TCP 514, from the session box
# only per the firewall) into a dedicated file tree.
cat > /etc/rsyslog.d/30-family-agent.conf <<'EOF'
module(load="imtcp")
input(type="imtcp" port="514" MaxSessions="20")

# Everything from the session box keeps its facility/severity; file by day.
if $fromhost-ip == '10.0.0.3' then /var/log/family-agent/%$YEAR%-%$MONTH%-%$DAY%.log
& stop
EOF
mkdir -p /var/log/family-agent
systemctl restart rsyslog

# AIDE baseline (first run takes a few minutes; later runs are the check).
if [ ! -f /var/lib/aide/aide.db ]; then
  aideinit --yes -w 2>/dev/null | tail -1 || echo "aideinit finished (warnings above are normal)"
fi

# Caddyfile self-update: the repo is public; fetch the reviewed config
# now and check every 15 minutes. This also places the initial files when
# the box is being bootstrapped from this script alone.
install -m 755 "$(dirname "$0")/update-caddyfile.sh" /usr/local/bin/update-caddyfile.sh
/usr/local/bin/update-caddyfile.sh
cat > /etc/cron.d/family-agent-caddyfile <<'EOF'
*/15 * * * * root /usr/local/bin/update-caddyfile.sh >/dev/null 2>&1
EOF

# Backups land from the session box via rsync over the private network.
mkdir -p /opt/family-agent-backups

cd /opt/family-agent
docker compose -f phase1/deploy/proxy/compose.yml up -d
echo "vault up: proxy $(docker inspect -f '{{.State.Status}}' fa-proxy 2>/dev/null || echo starting), firewall, rsyslog, aide, cron"
