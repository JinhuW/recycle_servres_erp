# Build context: repository root.
FROM node:22-slim AS base
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
ENV NODE_ENV=production
EXPOSE 8787
# Run migrations, then start the server (single instance — no migration race).
CMD ["sh", "-c", "node ./scripts/migrate.mjs && pnpm start"]
