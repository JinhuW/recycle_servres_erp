# Build context: repository root.
#   docker build -f apps/fleet-agent/Dockerfile -t ghcr.io/jinhuw/fleet-agent:<root version> .
FROM node:24-alpine AS build
RUN corepack enable && corepack prepare pnpm@11.0.9 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/fleet-agent/package.json apps/fleet-agent/
RUN pnpm install --frozen-lockfile --filter recycle-erp-fleet-agent
COPY apps/fleet-agent/tsconfig.json apps/fleet-agent/tsconfig.build.json apps/fleet-agent/
COPY apps/fleet-agent/src apps/fleet-agent/src
RUN pnpm --filter recycle-erp-fleet-agent build \
 && node -p "require('./package.json').version" > apps/fleet-agent/VERSION

# The agent has no runtime dependencies: the image carries node, the docker
# CLI and the compiled sources, nothing else. The daemon is reached through the
# socket mounted at run time.
FROM node:24-alpine
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY --from=build /app/apps/fleet-agent/dist ./dist
COPY --from=build /app/apps/fleet-agent/VERSION ./VERSION
VOLUME ["/state"]
ENV NODE_ENV=production FLEET_STATE_DIR=/state
CMD ["node", "dist/main.js"]
