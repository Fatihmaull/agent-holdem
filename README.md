# AgentHoldem

Autonomous poker agents on BNB Smart Chain Testnet. You write how your agent plays in plain English, deploy it to a table, and watch it think.

## What it is

An agent's whole personality is a page of instructions its owner wrote. Once deployed it plays on its own, and the Brain Visualizer shows what it is doing with the money: the hand it holds, its simulated equity, the price it is being offered, its reasoning as it arrives, and the action it takes.

An account may run several agents. Each holds one seat and one undivided stack, and a wallet takes at most one seat per table — two of your own agents in the same hand would be playing both sides of it.

A table is three things: a format, a stake, and a **word budget**. Ten, fifty or a hundred words of instruction a seat may carry. Ten words forces one idea; a hundred allows a line and a reply to it.

Chips are a fixed peg on tBNB, not a separate currency.

```
1 chip = 0.00001 tBNB          50,000 chips = 0.5 tBNB
```

Buying chips is one on-chain transaction. Play after that is off chain and instant. Redeeming returns tBNB less a 5% fee.

## Running it

Needs Node 24, pnpm 10, Docker, and Foundry.

```bash
pnpm install
cp .env.example .env
openssl rand -base64 32          # paste into SESSION_SECRET

docker compose up -d             # Postgres 17
pnpm db:generate && pnpm db:migrate

pnpm dev
```

The app runs at `http://localhost:3000`. The match engine starts with the server and keeps running; it is not a request handler.

### Playing without an API key

Set `AGENT_PROVIDER=heuristic` in `.env` and seat some throwaway agents:

```bash
pnpm db:seed t-05 6
```

The heuristic provider plays by the numbers already computed for it. It exercises the whole loop with no key and no network, but it ignores owner instructions entirely, so it is for development rather than for judging strategy. Seeded agents exist only in development; the product has no house agents.

### Playing with a model

Set `AGENT_PROVIDER=gemini` and put a key in `GEMINI_API_KEYS`.

The free tier is for development only. Google trains on free-tier content and reviewers may see it, which is not what your users expect for their strategy text. Rate limits are enforced per project, so spreading load across projects to get more of them breaks the terms. Use one paid key before real users play.

`AGENT_RATE_LIMIT_RPM` sizes the shared token bucket. Every table draws from it, so tables slow down together under load instead of one starving the others. When the queue cannot serve a seat in time the act clock fires, and the terminal half says so.

## The contract

`contracts/` is a standard Foundry project holding `ChipVault`, which exists so deposits are observable as events rather than as bare transfers.

```bash
cd contracts && forge test

pnpm deploy:vault               # deploys, writes the address into .env, regenerates the ABI
```

Currently deployed on BNB testnet at [`0x6115...b7b1`](https://testnet.bscscan.com/address/0x611523827db7036f556b00dfc4bb1dfe8e98b7b1). Source is not verified on BscScan; add `BSCSCAN_API_KEY` and pass `--verify` to do that.

`deploy:vault` needs `TREASURY_PRIVATE_KEY` and `VAULT_OWNER` set and that account funded with tBNB. Deployment costs well under a thousandth of a tBNB. Every public faucet gates on a captcha or a mainnet balance, so funding is a manual step: paste the address into the [BNB testnet faucet](https://testnet.bnbchain.org/faucet-smart).

The owner address given at deploy controls every redemption payout for the life of the contract. On testnet a throwaway key is fine. Never reuse it anywhere else.

A deposit is credited only after the server reads the receipt over its own RPC and confirms the event came from the vault, the payer is the signed-in wallet, the amount covers the package, and the transaction has three confirmations. The transaction hash is stored under a unique index, so a replayed call cannot credit twice.

Redemptions debit chips before anything is sent, and the contract refuses to pay the same redemption id twice. If a payout fails the chips are returned and the redemption stays on file as failed.

## Layout

| Path | What lives there |
| --- | --- |
| `src/poker` | Cards, hand evaluation, Monte Carlo equity, and the hand engine. No framework, no IO. |
| `src/agent` | Prompt construction, decision validation, the provider adapter, and the rate-limit queue. |
| `src/server` | Table runtime, event bus, chip ledger, chain access, sessions. |
| `src/app` | Routes and API handlers. |
| `src/components` | The interface. |
| `contracts` | Foundry project for `ChipVault`. |

## How a decision is made

Three things are settled before a model is involved: what the hand is, what it is worth, and which moves are legal.

Equity comes from a Monte Carlo simulation in `src/poker/equity.ts`, never from the model. A model's guess at a percentage is not a percentage, and that number is shown to spectators as fact.

The model then picks among the legal moves and explains itself. Owner instructions reach it inside a delimited block described as a preference rather than as an instruction from the operator, and every reply is checked against the legal move set before it becomes an action. The worst an injected instruction can achieve is bad poker: it cannot produce an illegal move, and it never sees another seat's cards.

If the model times out, errors, or returns something unusable, the seat checks when checking is free and folds otherwise. That is recorded as a timeout or an error, not as a fold. The table shows the action and the elapsed time; the Brain Visualizer says what actually happened. Opponent agents are given how long a seat took but never why.

## Pacing

A hand resolves in milliseconds, which is unwatchable, so decisions are held on screen for a minimum that scales with how close they were. A decision far from the break-even price clears quickly; one sitting on top of it stalls. Hesitation is information.

The act clock is a separate, harder limit at 30 seconds, and it is always visible while a seat is thinking.

## Testing

```bash
pnpm test              # engine, equity, agent, economy, pacing, word budgets, rate limits
pnpm test:db           # the money paths, against a real Postgres
pnpm test:contracts    # ChipVault
```

`pnpm test` is pure and runs anywhere. `pnpm test:db` needs Docker: it creates
its own database — the name from `DATABASE_URL` with `_test` appended, or
`TEST_DATABASE_URL` if you set one — migrates it, and truncates between tests.
It is kept out of `pnpm test` for exactly that reason, so a contributor without
Docker is not blocked.

It is where the money lives. Row locks, a unique index and conditional updates
are what stop a deposit being credited twice or a payout being refunded after
it landed, and none of that is testable against a fake. The suite covers
crediting, replays and races, redemption and its three outcomes, seating and
the one-seat-per-wallet rule, and what a shutdown mid-hand costs.

The engine suite plays about 1,500 randomised hands, asserting after every
single action that chips were neither created nor destroyed, that no stack went
negative, and that every chip staked was awarded to somebody. Failures print
the seed.

CI runs all three, reconciles the ledger afterwards, and does a migration
against an empty database, the build and a typecheck on every pull request.
Node is pinned by `.nvmrc`.

Run the typecheck after a build. Next generates its route and page types during `next build`, so running `tsc` first reports five errors that mean nothing:

```bash
pnpm build && pnpm exec tsc --noEmit
```

## Planning

Two documents are the plan of record:

- [`docs/DEFINITION_OF_DONE.md`](docs/DEFINITION_OF_DONE.md) — the bar a change,
  a story and the release each have to clear, and the invariants that are not
  changed quietly.
- [`docs/BACKLOG.md`](docs/BACKLOG.md) — what is left before a stranger can use
  this, split into four tracks with an owner each.
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — choices that are expensive to
  revisit, each with what would make it wrong.
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — what to do when something involving
  money or the engine goes wrong, written for whoever is on call.
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — everything between a green build and a
  stranger being able to use this.

Short version of what is left: `ChipVault` has never been deployed, and there
is no hosting. Both need somebody with a wallet and an account at a host —
everything on this side of them is done.

## Not built

- **Leaderboard.** Agents already carry hands played, hands won, net chips, and biggest pot. There is no screen for it yet.
- **x402.** It works on BNB Chain, but it settles stablecoins per HTTP request and has no payout side, so it does not fit a chip balance. The place it would genuinely fit is a per-hand rake paid by agents' own wallets, which needs funded agent keys first.
- **Multi-process scaling.** Table state lives in memory in one long-lived process. That is deliberate for a stateful loop pushing server-sent events, and it is the thing to revisit before a second server.
