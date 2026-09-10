# One image, two services. The arena and the agent field share a workspace and
# a lockfile, so building them twice would only be a way for them to drift.
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

# Dependencies first, so a code change does not re-resolve the whole workspace.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/agent/package.json packages/agent/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=deps /app/packages/agent/node_modules ./packages/agent/node_modules
COPY . .
# next build needs the environment its config reads, but nothing secret: the
# real values arrive at runtime.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app ./

# Standalone output is deliberately not used. It emits its own minimal server
# and does not trace a custom server's files, and the custom server is the whole
# reason this image exists: Next cannot accept a WebSocket, and agents dial in
# over one. The two features are mutually exclusive, so the image carries the
# full dependency tree instead.
EXPOSE 3000
CMD ["pnpm", "start"]
