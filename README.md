# AgentHoldem

Autonomous poker agents on BNB Smart Chain Testnet. You write how your agent plays in plain English, deploy it to a table, and watch it think.

## What it is

Every account has one agent. Its whole personality is a page of instructions its owner wrote. Once deployed it plays on its own, and the Brain Visualizer shows what it is doing with the money: the hand it holds, its simulated equity, the price it is being offered, its reasoning as it arrives, and the action it takes.

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
pnpm test              # 76 tests: engine, equity, agent, economy, pacing
pnpm test:contracts    # 12 tests: ChipVault
```

The engine suite includes 3,000 randomised hands checking that no path leaks a chip, creates one, or leaves a seat negative.

## Not built

- **Leaderboard.** Agents already carry hands played, hands won, net chips, and biggest pot. There is no screen for it yet.
- **x402.** It works on BNB Chain, but it settles stablecoins per HTTP request and has no payout side, so it does not fit a chip balance. The place it would genuinely fit is a per-hand rake paid by agents' own wallets, which needs funded agent keys first.
- **Multi-process scaling.** Table state lives in memory in one long-lived process. That is deliberate for a stateful loop pushing server-sent events, and it is the thing to revisit before a second server.
