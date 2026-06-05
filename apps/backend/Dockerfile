# Build context: repository root.
FROM node:24-slim AS base
RUN corepack enable
RUN corepack prepare pnpm@11.0.9 --activate
WORKDIR /app

# Workspace manifests first for layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/backend/package.json apps/backend/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter recycle-erp-backend...

# Source.
COPY packages/shared packages/shared
COPY apps/backend apps/backend

WORKDIR /app/apps/backend
# Build provenance, supplied by scripts/release.sh via --build-arg. Default to
# dev/unknown so a plain `docker build` with no args still succeeds; the
# release path overrides them and they surface at /api/health and as OCI
# image labels.
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$GIT_SHA
# Image defaults: lowest precedence in Compose env merge order — anything in
# the repo-root .env (env_file) or compose `environment:` overrides them.
# These exist so `docker compose up` works on a fresh clone with no .env at
# all. For prod, set NODE_ENV=production + CORS_ALLOWED_ORIGINS + a real
# JWT_SECRET in .env (which then wins over these defaults).
ENV NODE_ENV=development \
    JWT_SECRET=dev-jwt-secret-change-me-in-prod \
    ENABLE_DEMO_ACCOUNTS=true \
    ADMIN_EMAIL=admin@recycle.local \
    ADMIN_PASSWORD=admin \
    ADMIN_NAME=Admin \
    ADMIN_ROLE=manager \
    APP_VERSION=$APP_VERSION \
    GIT_SHA=$GIT_SHA

# Drop root: node:24-slim ships a non-root `node` user. Deps were installed as
# root above (needed for corepack/global store); hand the app tree to `node`
# and run the server unprivileged.
RUN chown -R node:node /app
USER node

EXPOSE 8787
# Real readiness: 200 only when the API can reach Postgres. Lets Docker/Compose
# and the edge proxy detect a dead backend instead of trusting the SPA's
# catch-all 200. node has fetch built in (Node 24) — no extra dependency.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Run migrations, provision the default admin (idempotent), then start the
# server. Single instance — no migration race.
CMD ["sh", "-c", "node ./scripts/migrate.mjs && node ./scripts/init-admin.mjs && pnpm start"]
