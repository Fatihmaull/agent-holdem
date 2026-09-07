# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
pnpm dev                      # Next.js + the match engine (engine boots with the server)
pnpm build                    # next build
pnpm lint                     # eslint

pnpm test                     # node test runner via tsx over src/**/*.test.ts
pnpm exec tsx --test src/poker/engine.test.ts                    # one file
pnpm exec tsx --test --test-name-pattern 'enforces the minimum raise' src/poker/engine.test.ts  # one test

pnpm test:contracts           # forge test in contracts/

docker compose up -d          # Postgres 17 on POSTGRES_PORT, data in ./.data/postgres
pnpm db:generate              # drizzle-kit generate after editing src/db/schema.ts
pnpm db:migrate               # apply drizzle/*.sql
pnpm db:seed [tableId] [n]    # seat throwaway dev agents, e.g. pnpm db:seed t-05 6

pnpm abi                      # contracts/out/... -> src/server/vault-abi.ts (run after any contract change)
pnpm deploy:vault             # forge deploy, writes NEXT_PUBLIC_CHIP_VAULT_ADDRESS into .env, regenerates ABI
```

`.env` is required; copy `.env.example`. `SESSION_SECRET` and `DATABASE_URL` must be set or server modules refuse to load. `contracts/lib/forge-std` is a git submodule; run `git submodule update --init` before `forge test`.

Set `AGENT_PROVIDER=heuristic` to run the whole loop with no model key. The heuristic provider ignores owner instructions, so it is for development only.

## Architecture

**The match engine is not a request handler.** `src/instrumentation.ts` calls `bootEngine()` once per server process, which starts every table in `src/server/registry.ts`. Each `TableRuntime` runs its own `while` loop dealing hands for the life of the process. Table state lives in memory, so a second server process would deal two copies of every table. The registry hangs off `globalThis` so `next dev` hot reloads do not start duplicates. `AGENTHOLDEM_DISABLE_ENGINE=1` suppresses the boot.

**Layering, strict.** `src/poker` is pure: cards, hand evaluation, Monte Carlo equity, and a functional hand engine with no framework and no IO. `src/lib` is pure too: the chip peg, table roster, pacing, deposit-intent encoding. `src/server` is the only layer that touches Postgres, the chain, or process state. API routes under `src/app/api` are thin: parse the body, get a session, call one function in `src/server/actions.ts`, translate `ActionError` into a 400. Business logic does not belong in a route.

**The model is never an authority.** `src/agent/decide.ts` settles what the hand is, what it is worth (`equityVsRandom`), and which moves are legal (`legalActions`) before a model is consulted. The reply is parsed and checked against the legal move set by `validateDecision`; anything unusable checks when checking is free and folds otherwise, recorded as `timeout` or `error` rather than as a fold. Never let a model produce an equity number or an action that skips validation. Owner instructions are user input and reach the prompt inside a delimited block described as a preference.

**Two seat numberings.** The engine numbers seats densely from zero; the table numbers them by chair, and chairs go sparse when someone in the middle stands up. `TableRuntime.lineup` is the only bridge, via `positionOf` and `chairOf`. Nothing outside those may assume the numbers agree. This is the most common source of bugs in `src/server/table.ts`.

**Redaction happens on the server.** The SSE route in `src/app/api/tables/[id]/stream/route.ts` re-renders any seat-carrying event as `runtime.view(viewerAgentId)` per subscriber instead of forwarding it, so another agent's hole cards are physically absent from the stream. Adding an event type that carries seat state means adding it to that re-render branch.

**Money is integers.** One chip is `WEI_PER_CHIP` (0.00001 tBNB) in both directions; pots and balances are integer chip counts and never touch a float or a wei value. Every balance change writes a row to `ledgerEntries` with `balanceAfter`, in the same transaction as the change. Deposits are credited only after `observeDeposit` reads the receipt over our own RPC, confirms the log came from the vault, and sees `REQUIRED_CONFIRMATIONS`; the tx hash carries a unique index so a replay cannot credit twice. Redemptions debit before paying and restore chips on failure.

**Pacing is a product feature.** `pacingFloor` holds a decision on screen longer the closer it sits to the break-even price, so hesitation reads as information. The model's own latency counts toward the floor. `ACT_CLOCK_MS` is the separate hard limit.

## Conventions

- Comments in this codebase explain why a thing is the way it is, not what the line does. Match that.
- Tests that import server modules must `import '../dev/test-env'` first, before any module that reads `DATABASE_URL`.
- Migrations are generated, never hand-written; edit `src/db/schema.ts` then `pnpm db:generate`.
- `src/server/vault-abi.ts` is generated. Edit the contract and run `pnpm abi`.
- Path alias `@/*` maps to `src/*`; app code uses it, server-internal modules use relative imports.
