# SPC-0018 restricted agent runner. The dispatcher runs as root inside the
# container (holds Paca/Outline/deploy keys); Claude Code runs as pwuser (uid 1001)
# with an allowlist of tools and no access to those keys.
FROM mcr.microsoft.com/playwright:v1.62.1-noble
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@2.1.286 \
 && npm cache clean --force
COPY dispatcher.js package.json /app/
WORKDIR /app
ENV PORT=3000 NODE_ENV=production
CMD ["node", "/app/dispatcher.js"]
