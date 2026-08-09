# Kleos — deploy-ready container image.
# No build step (plain Node + vanilla JS frontend), so this stays simple:
# install deps, copy source, run.
#
# Build:  docker build -t kleos .
# Run:    docker run -p 3000:3000 --env-file .env kleos
#
# The container itself is stateless — Postgres runs elsewhere (a managed
# host, or a separate container/service you point DATABASE_URL at).

FROM node:18-alpine

WORKDIR /app

# Install dependencies first so this layer only rebuilds when package.json
# actually changes, not on every source edit.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# db.js runs schema.sql (idempotent — CREATE TABLE IF NOT EXISTS / ALTER
# TABLE ... ADD COLUMN IF NOT EXISTS) on boot, so no separate migration step
# is needed here.
CMD ["node", "server.js"]
