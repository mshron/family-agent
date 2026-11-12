# Exec target: one container per conversation. No pi, no credentials, no
# browser (the system's one browser runs on the vault box; drive it with
# the browser tool). Tools run here through DockerExecutionEnv; the agent
# loop lives in the gateway. Egress reaches the internet only through
# the vault squid forward proxy (HTTPS_PROXY below); the session box's
# lockdown allows only the vault IP directly.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ripgrep ca-certificates openssh-client \
 && rm -rf /var/lib/apt/lists/*

RUN git config --global user.name "pi (family-agent)" \
 && git config --global user.email "pi@family-agent.local" \
 && git config --global init.defaultBranch main \
 && git config --global safe.directory '*'

# One egress hop: everything internet-bound goes through the vault
# forward proxy, where it is logged (and later, scannable). The proxy
# routes and the mark sidecar are reached directly, never via squid.
ENV HTTPS_PROXY=http://10.0.0.4:3128 \
    HTTP_PROXY=http://10.0.0.4:3128 \
    NO_PROXY=10.0.0.4,10.0.0.3,100.104.80.107,localhost,127.0.0.1

COPY mark /usr/local/bin/mark
RUN chmod +x /usr/local/bin/mark

WORKDIR /workspace
CMD ["sleep", "infinity"]
