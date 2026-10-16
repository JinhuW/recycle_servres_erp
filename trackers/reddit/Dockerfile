# Multi-arch by default: Oracle Cloud's Always Free VMs are ARM64 (Ampere A1),
# while Railway runs amd64. node:24-slim has images for both.
FROM node:24-slim

RUN corepack enable && corepack prepare pnpm@11.0.9 --activate

WORKDIR /app

# Dependencies first so source edits do not invalidate the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY tsconfig.json ./
COPY migrations ./migrations
COPY scripts ./scripts
COPY src ./src

USER node

# Running migrate on every start is safe with any number of instances: the
# runner takes a cluster-wide advisory lock and keeps a filename ledger, so a
# migration applies exactly once no matter how many VMs boot together.
#
# `exec node` matters: launching through `pnpm start` buries node under a pnpm
# wrapper and the tsx CLI, neither of which forwards SIGTERM. The worker would
# then never run its shutdown path, and every claim it held would stay locked
# until the 5-minute TTL expired. exec makes node PID 1 so it gets the signal.
CMD ["sh", "-c", "node --import tsx scripts/migrate.ts && exec node --import tsx src/index.ts"]
