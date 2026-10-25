# syntax=docker/dockerfile:1
# Production image of apps/api. Build context is the repo root:
#   docker build -f apps/api/Dockerfile .
# The workspace packages ship TypeScript source (no build step), so the image runs the sources
# with tsx. tsx is installed apart from the pnpm deploy so the app keeps its production set.
ARG NODE_IMAGE=node:22.23.3-slim
# Release builds pass the tag's version; it must equal the root package.json version.
ARG CODESH_VERSION=""

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install -g pnpm@9.15.4 --no-audit --no-fund
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=codesh-pnpm,target=/pnpm/store pnpm fetch --prod
COPY . .
ARG CODESH_VERSION
RUN --mount=type=cache,id=codesh-pnpm,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --prod --filter @gachipad/api... \
    && pnpm --filter @gachipad/api --prod deploy /out \
    && version="$(node -p 'require("./package.json").version')" \
    && { [ -z "$CODESH_VERSION" ] || [ "$CODESH_VERSION" = "$version" ] \
      || { echo "CODESH_VERSION=$CODESH_VERSION, package.json has $version" >&2; exit 1; }; } \
    && printf '%s\n' "$version" > /out/VERSION

FROM ${NODE_IMAGE} AS tsx
RUN npm install --prefix /opt/tsx --omit=dev --no-audit --no-fund tsx@4.23.15

FROM ${NODE_IMAGE} AS runtime
ARG CODESH_VERSION
LABEL org.opencontainers.image.title="codesh-api" \
      org.opencontainers.image.source="https://github.com/kim0040/codesh" \
      org.opencontainers.image.version="${CODESH_VERSION}"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=tsx /opt/tsx /opt/tsx
COPY --from=build --chown=root:root /out ./
COPY --chown=root:root LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/codesh/
# The package tsconfig extends the repo's base file, which is not part of the image.
RUN printf '%s\n' '{"compilerOptions":{"target":"ES2023","module":"ESNext","moduleResolution":"Bundler","verbatimModuleSyntax":true,"strict":true}}' > tsconfig.json
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--import", "/opt/tsx/node_modules/tsx/dist/esm/index.mjs", "src/main.ts"]
