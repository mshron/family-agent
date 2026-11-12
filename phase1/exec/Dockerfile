# Exec target: one container per conversation. No pi, no credentials.
# Tools run here through DockerExecutionEnv; the agent loop lives in the
# gateway. Egress reaches the internet only through the vault squid
# forward proxy (HTTPS_PROXY below); the session box's lockdown allows
# only the vault IP directly.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ripgrep ca-certificates openssh-client \
      chromium \
      fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

RUN git config --global user.name "pi (family-agent)" \
 && git config --global user.email "pi@family-agent.local" \
 && git config --global init.defaultBranch main \
 && git config --global safe.directory '*'

# agent-browser CLI (browser automation for skills: unsubscribe flows,
# page reading, screenshots). System Chromium keeps the image slim.
RUN npm install -g agent-browser@0.42.0 && npm cache clean --force
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
    AGENT_BROWSER_DATA_DIR=/tmp/agent-browser \
    AGENT_BROWSER_SOCKET_DIR=/tmp \
    AGENT_BROWSER_CONTENT_BOUNDARIES=1

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
