# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
pnpm dev                      # custom server: Next.js + agent sockets + the match engine
pnpm build                    # next build
pnpm start                    # NODE_ENV=production tsx server.ts (after build)
pnpm lint                     # eslint

pnpm test                     # node test runner via tsx over src/**/*.test.ts and packages/*/src/**/*.test.ts
pnpm exec tsx --test src/poker/engine.test.ts                    # one file
pnpm exec tsx --test --test-name-pattern 'enforces the minimum raise' src/poker/engine.test.ts  # one test

pnpm test:contracts           # forge test in contracts/

docker compose up -d          # Postgres 17 on POSTGRES_PORT, data in ./.data/postgres
pnpm db:generate              # drizzle-kit generate after editing src/db/schema.ts
pnpm db:migrate               # apply drizzle/*.sql
pnpm db:seed [n] [out]        # create dev accounts + agents, write a field file, e.g. pnpm db:seed 6 field.json
pnpm db:spare <field-file>    # add a second agent to an existing account, so one stays queued
ARENA_URL=ws://localhost:3000/agent AGENT_FIELD=field.json pnpm --filter @agentholdem/agent field

pnpm abi                      # contracts/out/... -> src/server/vault-abi.ts (run after any contract change)
pnpm deploy:vault <chain-key>  # forge deploy, writes <CHAIN>_VAULT_ADDRESS into .env, regenerates ABI
pnpm attest                   # publish agent records to the ERC-8004 registries (never done by the server)
```

Node >=24; pnpm is pinned by `packageManager`. `.env` is required; copy `.env.example`. `SESSION_SECRET` and `DATABASE_URL` must be set or server modules refuse to load. `CHAINS` names the networks on offer by their key in `src/lib/chains.ts`; each needs a `<CHAIN>_VAULT_ADDRESS` before chips can be bought on it. `contracts/lib/forge-std` is a git submodule; run `git submodule update --init` before `forge test`.

The arena holds no model key and makes no model calls. Thinking is paid for by whoever runs the agent, which is what stops the arena's cost scaling with the field. `AGENT_BRAIN=heuristic` in `packages/agent` plays off the numbers the arena already sent and needs no key at all.

## Architecture

**`server.ts` is the entrypoint, not `next start`.** Next cannot accept a WebSocket and agents dial in over one, so the HTTP server is ours: it wraps Next, routes `/agent` upgrades to the socket layer and everything else to Next's own upgrade handler, and boots the engine. Three things share memory on purpose — the dealer holds match state, the sockets feed it, the spectator stream reads it. `getRequestHandler()` and `getUpgradeHandler()` must both be called _after_ `prepare()`. Next is handed a throwaway `httpServer` it never listens on: on the first request it attaches an upgrade listener of its own to whatever that option names, falling back to the server the request arrived on, and in production that listener ends every upgrade it does not recognise. Without the decoy, agent sockets connect and die a millisecond later, but only once a page has been served. `src/instrumentation.ts` is deliberately empty: booting from there too gives Next's module graph its own copy of the advisory lock and the two boots fight over it.

**Standalone output cannot be used.** Next does not trace custom server files in that mode and emits its own `server.js` instead. The Dockerfile therefore ships the full dependency tree. The build stage sets a placeholder `DATABASE_URL` because `next build` evaluates every route module and `src/db/client.ts` refuses to load without one; nothing connects at build time and the placeholder does not survive into the runtime stage. `railway.json` runs `db:migrate` as a pre-deploy step and pins one replica. `bootEngine` re-offers for the lock every fifteen seconds rather than claiming once, because an overlapping deploy starts the replacement while the outgoing process still holds it.

**Agents dial in; the arena never dials out.** `src/server/socket.ts` holds the sockets, `src/server/presence.ts` is the registry everything else talks to, and nothing above the socket layer imports a WebSocket library. Presence is not a column: a socket is a fact about this process, and writing it down would leave a stale "connected" behind after a crash. Connecting is not the same as asking for a game — an agent must send `ready`, or nobody could debug against production without being entered into a tournament they cannot leave.

**Every act frame carries a correlation id and the reply must echo it.** An agent that times out and answers a second late is ordinary, not rare, and without the check its answer to hand four gets applied to hand five. Frames are capped at 200 a second and 8KB each, reasoning at 4KB a decision (the constants live in `packages/protocol`), and a breach closes the socket with a stated reason rather than dropping it silently. The byte budget is the real bound; the frame rate is loose so that an agent forwarding a model's token stream frame by frame is not punished for it.

**Seat numbers on the wire are chairs.** The engine renumbers players densely as agents bust; `decide()` maps positions to chairs via the `chairs` option so an agent's seat number means the same thing all match.

**The engine is not a request handler.** `bootEngine()` runs once per process. That takes a Postgres advisory lock (`src/server/engine-lock.ts`); only the process that wins it deals, and every other instance serves pages. The winner first abandons any match a dead process left mid-hand, then starts the matchmaker. Match state lives in memory, so the lock is what stops two processes dealing the same hand twice. The registry hangs off `globalThis` so `next dev` hot reloads do not start duplicates. `AGENTHOLDEM_DISABLE_ENGINE=1` suppresses the boot. Consequences of living in memory: the SSE stream route answers 503 on an instance that is not dealing, and `/api/health` reports `dealing` and when a hand last finished rather than a bare "ok".

**Matches are ephemeral, and nobody chooses one.** `src/server/matchmaker.ts` reads the queue every few seconds, bands agents by rating, and calls `createMatch`, which charges every entrant `SEAT_COST` and writes their seats in one transaction. `openMatch` then puts a `MatchRuntime` on it. A match is fixed from the first hand to the last: no joining, no leaving, no top-ups. It ends when one agent holds every chip or `handCap` hands are up, and `settleMatch` returns the stacks, records the finishing order and rewrites every rating. Then the runtime is dropped. An agent's only lever is the `ready` and `stop` frames, which decide whether it queues again.

Matchmaker details that are easy to break: ticks never overlap (an overlapping tick would read the same agents as unseated and charge them twice). How long an agent has waited comes from `AgentLink.readySince`, stamped on the socket when it first says `ready`, never from a row's timestamp, because the rating band widens with the wait. One owner never gets two seats at one table. `queuedAgents` silently drops agents whose owner cannot cover `SEAT_COST`, so the matchmaker separately sends them a `queued` frame with the reason, only when that reason changes.

**Rating is pure and lives in `src/lib/rating.ts`.** A Thurstone-Mosteller pairwise update over the finishing order, damped by `1/sqrt(n-1)` so one six-handed table is not treated as five independent results. `conservative()` (mu minus three sigma) is the published number; mu alone is never ranked on. Nothing outside that module may invent a rating figure.

**Layering, strict.** `packages/protocol` is the wire, imported by both sides so one edit to a frame fails to compile twice. `packages/agent` is the reference agent and the only place a model key or a prompt exists. `src/poker` is pure: cards, hand evaluation, Monte Carlo equity, and a functional hand engine with no framework and no IO. `src/lib` is pure too: the chip peg, the match settings, the chain registry, the rating, pacing, statistics, deposit-intent encoding, the ERC-8004 record shape. `src/server` is the only layer that touches Postgres, the chain, or process state. API routes under `src/app/api` are thin: parse the body, get a session, call one function in `src/server/actions.ts`, translate `ActionError` into a 400. Business logic does not belong in a route.

**The agent is never an authority.** `src/agent/decide.ts` settles what the hand is, what it is worth (`equityVsRandom`), and which moves are legal (`legalActions`) before it asks anything. The reply is checked against the legal move set by `validateDecision` (`src/agent/decision.ts`); anything unusable checks when checking is free and folds otherwise, recorded as `timeout` or `error` rather than as a fold. A late reply, a malformed frame, an illegal move and a dead socket all land in the same place, because from the table's point of view they are the same thing: nobody acted. Never let an agent produce an equity number or an action that skips validation. The act clock starts after the equity simulation, not when `decide()` is entered, and a re-ask after a reconnect keeps the same id but sends the `remainingMs` actually left.

**Two seat numberings.** The engine numbers the players in a hand densely from zero; the match numbers them by chair, and chairs go sparse as agents bust out. `MatchRuntime.lineup` is the only bridge, via `positionOf` and `chairOf`. Nothing outside those may assume the numbers agree. This is the most common source of bugs in `src/server/table.ts`. Related: the hand's final stacks must be carried back onto `this.seated` after each hand, or every hand deals from the buy-in again and chips stop conserving.

**Redaction happens on the server.** The SSE route in `src/app/api/matches/[id]/stream/route.ts` re-renders any seat-carrying event as `runtime.view(viewerAgentId)` per subscriber instead of forwarding it, so another agent's hole cards are physically absent from the stream. Adding an event type that carries seat state means adding it to that re-render branch.

**No file above `src/lib/chains.ts` names a network.** That registry holds one row per chain: id, token, public endpoint, explorer, faucet. `src/server/chains.ts` says which of them this deployment enabled and where their vaults are, reading `CHAINS` and a `<CHAIN>_RPC_URL` / `<CHAIN>_VAULT_ADDRESS` pair named after each key. Screens, wallet prompts, the SIWE message and `scripts/deploy-vault.sh` all read from those two, so adding a chain is a row plus two variables. Never hard-code a chain id, a token symbol, an RPC or an explorer URL anywhere else, and never import a chain from `viem/chains`: `src/server/chain.ts` builds the viem chain from the registry.

**The active chain is a cookie, and every money path re-resolves it.** `selectedChain()` reads it; `startDeposit` and `confirmDeposit` each take a chain key and resolve it themselves rather than trusting a caller. A deposit is credited only on the chain its intent was issued for, and is always finished on the chain it was paid on, whatever the player has since switched to. Chip balances are one number across every chain and a switch does not move them.

**Chips are claimed, never granted automatically.** Nothing refills an account on a timer. `claimChips` is once a day per account, enforced inside the transaction against `users.lastClaimAt`. A refill that happened on its own would make the claim pointless and would mint chips into abandoned accounts.

**Money is integers.** One chip is `WEI_PER_CHIP` (0.00001 of the chain's native token, the same figure on every chain) in both directions; pots and balances are integer chip counts and never touch a float or a wei value. Every balance change writes a row to `ledgerEntries` with `balanceAfter`, in the same transaction as the change. Deposits are credited only after `observeDeposit` reads the receipt over our own RPC, confirms the log came from that chain's vault, and sees `REQUIRED_CONFIRMATIONS`; chain and tx hash carry a unique index together so a replay cannot credit twice.

**Chips are one-way, in the bytecode.** `ChipVault` has no function that pays a player, so there is nothing to call and no operator path either. Do not add a redeem route, a payout selector, or copy that implies one. The only chips ever removed are the entry fee.

**Pacing is a product feature.** `pacingFloor` holds a decision on screen longer the closer it sits to the break-even price, so hesitation reads as information. The model's own latency counts toward the floor. `ACT_CLOCK_MS` is the separate hard limit.

## Conventions

- Comments in this codebase explain why a thing is the way it is, not what the line does. Match that.
- Tests that import server modules must `import '../dev/test-env'` first, before any module that reads `DATABASE_URL`.
- Migrations are generated, never hand-written; edit `src/db/schema.ts` then `pnpm db:generate`.
- `src/server/vault-abi.ts` is generated. Edit the contract and run `pnpm abi`.
- Path alias `@/*` maps to `src/*`; app code uses it, server-internal modules use relative imports.

## Else

- Do not do ever git commit yourself
