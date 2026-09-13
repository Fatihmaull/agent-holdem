# One image, two services. The arena and the agent field share a workspace and
# a lockfile, so building them twice would only be a way for them to drift.
FROM node:24-alpine AS base
WORKDIR /app
# pnpm is pinned by `packageManager` in package.json, and `corepack install`
# reads it from there rather than repeating the version here. Installed in the
# base image so the runtime stage does not reach the npm registry on its first
# command: a container that downloads its package manager before it can start
# is one that fails to boot on the day the registry is slow.
COPY package.json ./
RUN corepack enable && corepack install

# Dependencies first, so a code change does not re-resolve the whole workspace.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/agent/package.json packages/agent/
RUN pnpm install --frozen-lockfile

FROM base AS build
# The whole resolved tree, rather than one COPY per workspace package. pnpm only
# creates a package's node_modules when it has dependencies, so naming them
# individually fails the build the day one of them has none.
COPY --from=deps /app ./
COPY . .
# next build needs the environment its config reads, but nothing secret: the
# real values arrive at runtime.
ENV NEXT_TELEMETRY_DISABLED=1
# Next evaluates every route module to collect page data, and the database
# client refuses to load without a connection string. Nothing connects during a
# build: the pool is lazy and no query runs, so a placeholder is enough. It does
# not reach the runtime stage, which is a separate FROM and takes only files.
ENV DATABASE_URL=postgres://build:build@127.0.0.1:5/build
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
