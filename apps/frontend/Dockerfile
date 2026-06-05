# Build context: repository root.
FROM node:24-slim AS build
RUN corepack enable && corepack prepare pnpm@11.0.9 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/frontend/package.json apps/frontend/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter recycle-erp-frontend...
COPY packages/shared packages/shared
COPY apps/frontend apps/frontend
RUN pnpm --filter recycle-erp-frontend build

FROM caddy:2-alpine
# Build provenance (see scripts/release.sh). Re-declared here because ARGs
# don't cross stage boundaries; defaults keep a plain `docker build` working.
# The footer reads the version at runtime from /api/health, so the static
# bundle needs no version baked in — these are just OCI labels for `docker
# inspect`.
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$GIT_SHA
COPY apps/frontend/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/frontend/dist /srv
EXPOSE 80
