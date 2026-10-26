FROM node:22-bookworm-slim

# Browsers go in a shared folder so the non-root user can run them.
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=3000 \
    HOST=0.0.0.0 \
    SITELAPSE_NO_SANDBOX=1

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* \
 && chmod -R a+rX /ms-playwright

COPY server.js index.html ./

# Hugging Face Spaces (and many other hosts) run the container as user 1000.
# The node image already has that user, named "node".
RUN mkdir -p /app/cache && chown -R node:node /app/cache
USER node

EXPOSE 3000
CMD ["node", "server.js"]
