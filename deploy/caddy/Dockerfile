# syntax=docker/dockerfile:1
# Caddy with the built web app (apps/web/dist). Build context is the repo root:
#   docker build -f deploy/caddy/Dockerfile .
ARG NODE_IMAGE=node:22.23.3-slim
ARG CADDY_IMAGE=caddy:2.11.7-alpine

FROM ${NODE_IMAGE} AS web
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install -g pnpm@9.15.4 --no-audit --no-fund
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=codesh-pnpm,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=codesh-pnpm,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter @codesh/web... \
    && pnpm --filter @codesh/web build \
    && node deploy/caddy/csp.mjs

FROM ${CADDY_IMAGE} AS runtime
COPY --from=web /repo/Caddyfile.production /etc/caddy/Caddyfile
COPY --from=web /repo/apps/web/dist /srv
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
EXPOSE 80 443
# The admin endpoint listens on localhost only; a 200 means the config is loaded.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:2019/config/"]
