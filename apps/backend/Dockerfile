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

# Drop root: node:22-slim ships a non-root `node` user. Deps were installed as
# root above (needed for corepack/global store); hand the app tree to `node`
# and run the server unprivileged.
RUN chown -R node:node /app
USER node

EXPOSE 8787
# Real readiness: 200 only when the API can reach Postgres. Lets Docker/Compose
# and the edge proxy detect a dead backend instead of trusting the SPA's
# catch-all 200. node has fetch built in (Node 22) — no extra dependency.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Run migrations, then start the server (single instance — no migration race).
CMD ["sh", "-c", "node ./scripts/migrate.mjs && pnpm start"]
