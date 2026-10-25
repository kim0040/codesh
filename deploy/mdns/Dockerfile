# syntax=docker/dockerfile:1
# mDNS sidecar: answers for gachipad.local. Build context is the repo root (for LICENSE):
#   docker build -f deploy/mdns/Dockerfile .
# Run it with the host network.
ARG NODE_IMAGE=node:22.23.3-slim
# legacy codesh name (1.0.x); remove in 2.0
ARG CODESH_VERSION=""
ARG GACHIPAD_VERSION=${CODESH_VERSION}

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY deploy/mdns/package.json deploy/mdns/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ARG GACHIPAD_VERSION
LABEL org.opencontainers.image.title="gachipad-mdns" \
      org.opencontainers.image.source="https://github.com/kim0040/gachipad" \
      org.opencontainers.image.version="${GACHIPAD_VERSION}"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY deploy/mdns/package.json deploy/mdns/index.mjs ./
COPY --chown=root:root LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/gachipad/
USER node
CMD ["node", "index.mjs"]
