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
pnpm db:seed [n]              # create throwaway dev agents that queue like anyone else, e.g. pnpm db:seed 6

pnpm abi                      # contracts/out/... -> src/server/vault-abi.ts (run after any contract change)
pnpm deploy:vault <chain-key>  # forge deploy, writes <CHAIN>_VAULT_ADDRESS into .env, regenerates ABI
pnpm attest                   # publish agent records to the ERC-8004 registries (never done by the server)
```

`.env` is required; copy `.env.example`. `SESSION_SECRET` and `DATABASE_URL` must be set or server modules refuse to load. `CHAINS` names the networks on offer by their key in `src/lib/chains.ts`; each needs a `<CHAIN>_VAULT_ADDRESS` before chips can be bought on it. `contracts/lib/forge-std` is a git submodule; run `git submodule update --init` before `forge test`.

Set `AGENT_PROVIDER=heuristic` to run the whole loop with no model key. The heuristic provider ignores owner instructions, so it is for development only.

## Architecture

**The match engine is not a request handler.** `src/instrumentation.ts` calls `bootEngine()` once per server process. That takes a Postgres advisory lock (`src/server/engine-lock.ts`); only the process that wins it deals, and every other instance serves pages. The winner first abandons any match a dead process left mid-hand, then starts the matchmaker. Match state lives in memory, so the lock is what stops two processes dealing the same hand twice. The registry hangs off `globalThis` so `next dev` hot reloads do not start duplicates. `AGENTHOLDEM_DISABLE_ENGINE=1` suppresses the boot.

**Matches are ephemeral, and nobody chooses one.** `src/server/matchmaker.ts` reads the queue every few seconds, bands agents by rating, and calls `createMatch`, which charges every entrant `SEAT_COST` and writes their seats in one transaction. `openMatch` then puts a `MatchRuntime` on it. A match is fixed from the first hand to the last: no joining, no leaving, no top-ups. It ends when one agent holds every chip or `handCap` hands are up, and `settleMatch` returns the stacks, records the finishing order and rewrites every rating. Then the runtime is dropped. An agent's only lever is `seeking`, which decides whether it queues again.

**Rating is pure and lives in `src/lib/rating.ts`.** A Thurstone-Mosteller pairwise update over the finishing order, damped by `1/sqrt(n-1)` so one six-handed table is not treated as five independent results. `conservative()` (mu minus three sigma) is the published number; mu alone is never ranked on. Nothing outside that module may invent a rating figure.

**Layering, strict.** `src/poker` is pure: cards, hand evaluation, Monte Carlo equity, and a functional hand engine with no framework and no IO. `src/lib` is pure too: the chip peg, the match settings, the chain registry, the rating, pacing, statistics, deposit-intent encoding, the ERC-8004 record shape. `src/server` is the only layer that touches Postgres, the chain, or process state. API routes under `src/app/api` are thin: parse the body, get a session, call one function in `src/server/actions.ts`, translate `ActionError` into a 400. Business logic does not belong in a route.

**The model is never an authority.** `src/agent/decide.ts` settles what the hand is, what it is worth (`equityVsRandom`), and which moves are legal (`legalActions`) before a model is consulted. The reply is parsed and checked against the legal move set by `validateDecision`; anything unusable checks when checking is free and folds otherwise, recorded as `timeout` or `error` rather than as a fold. Never let a model produce an equity number or an action that skips validation. Owner instructions are user input and reach the prompt inside a delimited block described as a preference.

**Two seat numberings.** The engine numbers the players in a hand densely from zero; the match numbers them by chair, and chairs go sparse as agents bust out. `MatchRuntime.lineup` is the only bridge, via `positionOf` and `chairOf`. Nothing outside those may assume the numbers agree. This is the most common source of bugs in `src/server/table.ts`. Related: the hand's final stacks must be carried back onto `this.seated` after each hand, or every hand deals from the buy-in again and chips stop conserving.

**Redaction happens on the server.** The SSE route in `src/app/api/matches/[id]/stream/route.ts` re-renders any seat-carrying event as `runtime.view(viewerAgentId)` per subscriber instead of forwarding it, so another agent's hole cards are physically absent from the stream. Adding an event type that carries seat state means adding it to that re-render branch.

**No file above `src/lib/chains.ts` names a network.** That registry holds one row per chain: id, token, public endpoint, explorer, faucet. `src/server/chains.ts` says which of them this deployment enabled and where their vaults are, reading `CHAINS` and a `<CHAIN>_RPC_URL` / `<CHAIN>_VAULT_ADDRESS` pair named after each key. Screens, wallet prompts, the SIWE message and `scripts/deploy-vault.sh` all read from those two, so adding a chain is a row plus two variables. Never hard-code a chain id, a token symbol, an RPC or an explorer URL anywhere else, and never import a chain from `viem/chains`: `src/server/chain.ts` builds the viem chain from the registry.

**The active chain is a cookie, and every money path re-resolves it.** `selectedChain()` reads it; `startDeposit` and `confirmDeposit` each take a chain key and resolve it themselves rather than trusting a caller. A deposit is credited only on the chain its intent was issued for, and is always finished on the chain it was paid on, whatever the player has since switched to. Chip balances are one number across every chain and a switch does not move them.

**Money is integers.** One chip is `WEI_PER_CHIP` (0.00001 of the chain's native token, the same figure on every chain) in both directions; pots and balances are integer chip counts and never touch a float or a wei value. Every balance change writes a row to `ledgerEntries` with `balanceAfter`, in the same transaction as the change. Deposits are credited only after `observeDeposit` reads the receipt over our own RPC, confirms the log came from that chain's vault, and sees `REQUIRED_CONFIRMATIONS`; chain and tx hash carry a unique index together so a replay cannot credit twice.

**Chips are one-way, in the bytecode.** `ChipVault` has no function that pays a player, so there is nothing to call and no operator path either. Do not add a redeem route, a payout selector, or copy that implies one. The only chips ever removed are the entry fee.

**Pacing is a product feature.** `pacingFloor` holds a decision on screen longer the closer it sits to the break-even price, so hesitation reads as information. The model's own latency counts toward the floor. `ACT_CLOCK_MS` is the separate hard limit.

## Conventions

- Comments in this codebase explain why a thing is the way it is, not what the line does. Match that.
- Tests that import server modules must `import '../dev/test-env'` first, before any module that reads `DATABASE_URL`.
- Migrations are generated, never hand-written; edit `src/db/schema.ts` then `pnpm db:generate`.
- `src/server/vault-abi.ts` is generated. Edit the contract and run `pnpm abi`.
- Path alias `@/*` maps to `src/*`; app code uses it, server-internal modules use relative imports.
