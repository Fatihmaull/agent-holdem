# Decisions

Choices that are expensive to revisit, written down with what we knew at the
time. A decision that is not recorded gets re-argued every few months by people
who each remember a different version of it.

Each entry says what was decided, when, and — the part that matters — what
would make it wrong.

---

## 1 · Table state stays in one process

**Decided:** September 2026 · **Backlog:** C6 ([#20](https://github.com/Fatihmaull/agent-holdem/issues/20))
· **Status:** not yet, and here is why

`src/server/registry.ts` holds every `TableRuntime` in memory, one process deals
every table, and a second instance would deal a second copy of all six while
both wrote to the same database. That is a real ceiling and it rules out
serverless and autoscaling entirely. The question is whether to shard tables
across processes with explicit ownership now.

**No, because the process is nowhere near being the limit.** Two numbers say so.

### What a hand actually costs

Measured on the development container, one core:

| Street | Samples | Per decision |
| --- | --- | --- |
| Preflop | 3,000 | 7.1 ms |
| Flop | 2,500 | 3.9 ms |
| Turn | 2,000 | 2.9 ms |
| River | 1,000 | 1.3 ms |

The Monte Carlo equity simulation is the only meaningful CPU in the loop, and
it is about **4 ms per decision**. Everything else — building the prompt,
validating the reply, rendering a view — is arithmetic over a handful of seats.

Six tables at full occupancy produce roughly **70 decisions a minute**: a hand
runs 60 to 90 seconds at the pacing in `src/lib/pacing.ts`, and a full 6-max
hand takes ten to twenty of them. Seventy decisions a minute at 4 ms each is
**0.5% of one core**. The engine is idle. It is waiting.

### What it is waiting for

The model. `AGENT_RATE_LIMIT_RPM` defaults to 10 per key, and the roster wants
about 70 requests a minute at full occupancy — so a single free-tier key runs
the tables at a seventh of their pace, and every seat spends most of its clock
in the queue rather than thinking.

That is the ceiling. It is a budget, not a process, and **sharding tables
across processes does not raise it**: the same starved quota gets spread over
more processes, each of which now has to agree with the others about who owns
which table. Distributed ownership is a real problem to take on, and it would
buy a resource we already have far too much of.

### What would make this wrong

Three things, in the order we expect to meet them:

1. **The model budget grows.** With quota for several hundred decisions a
   minute, more tables become worth running, and at somewhere around thirty to
   fifty tables the CPU cost of the simulations starts to be visible against
   the event loop that also serves every spectator.
2. **Spectators outgrow one process.** The SSE route re-renders
   `runtime.view(viewer)` per subscriber per event, so a table with a thousand
   watchers costs a thousand view renders an event. The fix for that is not
   sharding tables — it is splitting the read path from the engine, which is a
   different and easier change: spectators can be served by any number of
   processes reading a feed the engine publishes.
3. **Uptime stops being negotiable.** One process means a deploy is a pause and
   a crash is an outage. Today the drain in `src/server/lifecycle.ts` makes
   that cost a hand rather than chips, which is acceptable for a testnet
   product. It stops being acceptable the moment real money is involved.

Until then, the single process is not a compromise we are living with. It is
the reason the seat numbering, the redaction and the leave-mid-hand handling
are as simple as they are, and every one of those would get harder under
sharding.

### What follows from it

Written down so nobody re-derives them:

- **The rate limiter is in memory** (`src/server/rate-limit.ts`). A counter in
  the one process that owns the tables is exactly as authoritative as the
  tables. It moves to the database or to Redis when this decision does.
- **Serverless and autoscaling are configuration errors**, not deployment
  choices. `docs/DEPLOY.md` says to pin the instance count to one, and says why
  next to the setting.
- **The deposit watcher holds a scan cursor** and must not be duplicated for
  the same reason: two sweeps from one cursor read the same logs twice.

---

## 2 · Contract tests run on every pull request

**Decided:** September 2026 · **Backlog:** B1 ([#9](https://github.com/Fatihmaull/agent-holdem/issues/9))

The ticket asked for `forge test` "when `contracts/` changed". CI runs it every
time instead.

A required status check that is skipped never reports, and a pull request then
waits forever on a check that will never arrive. That is a well-known way to
make branch protection unusable, and the contract suite finishes in about nine
seconds, so always running it costs less than the trap.

**What would make this wrong:** the suite growing to the point where it is a
meaningful share of the ten-minute budget. Then use a path filter *plus* a
skipped-job shim that reports success, rather than a bare filter.

---

## 3 · An account may own several agents

**Decided:** September 2026 · **Backlog:** the multi-table deploy

Deploying one piece of writing to several tables at once collided with two
invariants: an agent holds one seat, and an account holds one agent. One of
them had to give.

**The account rule gave.** "One agent per account" is about identity; "one seat
per agent" is about a stack never being split, and only the second has money
behind it. An account may now own up to one agent per table, each with its own
colour, record and undivided stack. They share the text an owner wrote, not the
chips.

The collusion risk this opens — two of your own agents in one hand, seeing two
sets of hole cards and playing both sides — is closed at the table rather than
at the account: **a wallet holds at most one seat per table**, enforced under a
`FOR UPDATE` lock on the account row, because two concurrent joins would each
otherwise read "no seat of mine here" and both succeed. There is a test that
races them.

**What would make this wrong:** somebody finding a way to collude across
tables rather than within one — the same owner's agents at different tables
signalling through table talk, say. The mitigation would be at the talk, not at
the seat.

---

## 4 · The heuristic provider never judges a real hand

**Decided:** at the start, restated here because it keeps coming up

`AGENT_PROVIDER=heuristic` plays the whole loop with no API key, which is what
makes the product developable and testable. It reads the equity the server
already computed and picks the arithmetically sensible line — which means **it
ignores what the owner wrote entirely**.

That is the point. It exercises the loop without pretending to be an agent with
a personality. It refuses to start when `NODE_ENV=production`, and it must keep
refusing: a table where the writing does not matter is not this product.
