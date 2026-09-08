# Two stages: one that has the toolchain, one that runs the server.
#
# The runtime stage carries no node_modules, no pnpm and no TypeScript —
# `output: 'standalone'` bundles the server with only the dependencies it
# actually reaches. Smaller image, and nothing in it can be used to build
# something other than what was built here.

# ── Build ──────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# `next build` collects page data for every API route, which imports db/client,
# which refuses to load without a connection string. It never opens a
# connection during the build — the value only has to exist, and this one is
# deliberately not a real database.
ENV DATABASE_URL=postgres://build:build@127.0.0.1:5432/build
ENV SESSION_SECRET=build-only-never-used-at-runtime
ENV AGENTHOLDEM_DISABLE_ENGINE=1
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm build

# Migrations run at deploy time rather than at build time, so the tools to run
# them have to come along. Everything else is left behind.
RUN pnpm install --frozen-lockfile --prod=false --ignore-scripts \
  && pnpm exec tsx --version > /dev/null

# ── Runtime ────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Takes the shutdown signals off Next, which would otherwise exit as soon as
# the HTTP server closed and cut a hand off mid-deal. src/server/lifecycle.ts
# drains instead: no new hands, finish the ones in flight, then exit.
#
# The platform's own termination grace period must be higher than
# SHUTDOWN_DRAIN_MS, or the container is killed before the drain can act.
ENV NEXT_MANUAL_SIG_HANDLE=1
ENV SHUTDOWN_DRAIN_MS=45000

# One JSON object per line, which is what a log collector wants.
ENV LOG_FORMAT=json

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# For `pnpm db:migrate` as a release command. Nothing here is loaded by the
# server itself.
COPY --from=build /app/node_modules ./migrate-tools/node_modules
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/src/db ./src/db
COPY --from=build /app/package.json ./package.json

USER node
EXPOSE 3000

# Reports whether the engine is dealing, not merely whether the process
# answers. A container that responds while its tables have stopped is the
# failure this exists for.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
