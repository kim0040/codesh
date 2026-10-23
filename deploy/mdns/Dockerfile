# syntax=docker/dockerfile:1
# mDNS sidecar: answers for codesh.local. Build context is deploy/mdns; run it with the host network.
ARG NODE_IMAGE=node:22.23.3-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json index.mjs ./
USER node
CMD ["node", "index.mjs"]
