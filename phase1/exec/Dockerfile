# Exec target: one container per conversation. No pi, no credentials,
# no network egress rules yet (Phase 2). Tools run here through
# DockerExecutionEnv; the agent loop lives in the gateway.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN git config --global user.name "pi (family-agent)" \
 && git config --global user.email "pi@family-agent.local" \
 && git config --global init.defaultBranch main \
 && git config --global safe.directory '*'

WORKDIR /workspace
CMD ["sleep", "infinity"]
