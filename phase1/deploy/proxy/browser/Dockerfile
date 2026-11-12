# The vault browser: agent-browser on system Chromium, the ONE browser of
# the system, living on the trusted box. Card data arrives via container
# environment (proxy.env) and never leaves this container in any output.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g agent-browser@0.42.0 && npm cache clean --force

ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
    AGENT_BROWSER_CONTENT_BOUNDARIES=1

COPY service.js /srv/service.js

EXPOSE 8090
CMD ["node", "/srv/service.js"]
