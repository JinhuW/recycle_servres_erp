# Build context: repository root.
FROM node:22-slim AS build
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
COPY apps/frontend/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/frontend/dist /srv
EXPOSE 80
