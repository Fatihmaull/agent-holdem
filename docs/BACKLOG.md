# Backlog — getting to a usable product

The bar is in [`DEFINITION_OF_DONE.md`](./DEFINITION_OF_DONE.md): a stranger
with a wallet and testnet tBNB can arrive, buy chips, deploy an agent, watch it
play and cash out, and none of it depends on one of us being awake.

## Where we actually are

The game is finished. The poker engine, the agent loop, the tables, the word
budgets, the drafts, the multi-table deploy, the auth and the schema all work
and are tested. What is missing is everything between "works on a laptop" and
"a stranger can use it".

Two facts set the whole plan:

1. **`ChipVault` has never been deployed.** `NEXT_PUBLIC_CHIP_VAULT_ADDRESS` is
   empty, so the cashier cannot take a deposit. Nobody outside this repo can
   obtain a chip. Every money story is blocked on this one task.
2. **Deposits are confirmed by the browser.** `confirmDeposit` is only ever
   called from `cashier.tsx`. Send tBNB, close the tab, and the intent stays
   `pending` forever — the user has paid and has nothing. This is the most
   serious defect we have and it is invisible until someone loses money.

Everything else is either infrastructure we have none of (no CI, no hosting,
no monitoring, no rate limiting) or product polish.

## The four tracks

| Track | Owner | Why them |
| --- | --- | --- |
| **A · Chain & Money** | **@lagxy** | Wrote `ChipVault`, `chain.ts`, the peg and the ledger. The P0 blockers are all in code he authored. |
| **B · Platform & Release** | **@fatihmaull** | Owns the repository. Branch protection, deploy targets, secret storage and the treasury key need admin rights nobody else has. |
| **C · Engine & Reliability** | *TBA — dev 3* | Backend-leaning. Owns the engine's behaviour under restart, load and abuse. |
| **D · Product & Frontend** | *TBA — dev 4* | Frontend-leaning. Owns everything a visitor sees and whether they understand it. |

Tracks C and D are written as roles, not people. Swap the names in when the
other two developers are known; the work does not change.

## Order of play

```
        B1 CI ──────────────┬──────────────────────────► unblocks reviews for everyone
                            │
   A1 Deploy vault ──► A2 Deposit watcher ──► A3 Redemption reliability
        │                                              │
        └──► B2 Hosting ──► B3 Secrets ──► B4 Staging ─┘
                            │
                     C1 Graceful restart
                            │
                     C2 Rate limiting        D1 Onboarding
```

**Do first, in this order:** B1, A1, A2. B1 because four people sharing `main`
without CI will break it within a week. A1 because nothing about money can be
tested until the vault exists. A2 because it is the one open defect that costs
a user real value.

Estimates are rough days for one person, meant for sequencing rather than for
promising a date.

---

# Track A · Chain & Money — @lagxy

### A1 · [#3](https://github.com/Fatihmaull/agent-holdem/issues/3) · Deploy ChipVault to BNB testnet — **P0** — 1d
Nothing in the cashier works until this exists.

- `git submodule update --init` so `forge test` runs; contract tests green.
- Deployed with `pnpm deploy:vault`, owner set deliberately (not just the
  deployer by accident).
- Verified on BscScan so anyone can read it.
- `pnpm abi` regenerated and committed; `NEXT_PUBLIC_CHIP_VAULT_ADDRESS` set in
  the deployed environment.
- A real deposit from a real wallet credits chips end to end.

**Blocks:** A2, A3, A4, B4, and every money-related acceptance criterion.

### A2 · [#4](https://github.com/Fatihmaull/agent-holdem/issues/4) · Credit deposits without the browser — **P0** — 3d
The defect above. A user who closes the tab after paying must still get chips.

- A server-side watcher reconciles `deposit_intents` that are `pending`,
  independent of any open page.
- It survives the server being down when the transaction landed: on boot,
  pending intents from before the restart are picked up.
- Replay-safe. The unique index on `tx_hash` already makes double-crediting a
  database error rather than a race — keep it that way and prove it with a
  test that submits the same hash twice.
- `REQUIRED_CONFIRMATIONS` is still honoured; nothing is credited early.
- An intent that never receives a matching transaction expires rather than
  sitting `pending` forever.
- The existing browser path keeps working, so a user watching gets their chips
  immediately rather than waiting for the watcher.

### A3 · [#5](https://github.com/Fatihmaull/agent-holdem/issues/5) · Redemption reliability and the `PayoutUncertain` runbook — **P0** — 2d
Paying out is the half of the peg we have never exercised.

- A failed payout returns the chips; verified by test, not by reading the code.
- `PayoutUncertain` — sent but unconfirmed — has a written procedure: how to
  tell whether it landed, and what to do either way. Written where an on-call
  person will find it, not in a commit message.
- A script lists redemptions needing a human decision.
- The 5% fee is shown to the user before they confirm, and matches what the
  contract takes.

### A4 · [#6](https://github.com/Fatihmaull/agent-holdem/issues/6) · Chip reconciliation script — **P1** — 2d
Proof that we have not invented or lost chips.

- `pnpm reconcile` checks, for every account: `users.chips` plus its seat
  stacks equals the sum of its ledger entries.
- Reports the drift per account and exits non-zero if any exists.
- Runs nightly in CI once B1 exists, and fails loudly.

### A5 · [#7](https://github.com/Fatihmaull/agent-holdem/issues/7) · Treasury key handling and balance alerting — **P1** — 1d
- The key lives only in the deploy platform's secret store. Rotation is
  documented and has been done once as a drill.
- An alert fires while the treasury still has enough tBNB to pay out, not after
  redemptions have started failing.
- The runbook says who tops it up and from where.

### A6 · [#8](https://github.com/Fatihmaull/agent-holdem/issues/8) · Contract tests in CI — **P2** — 1d
Depends on **B1**. `forge test` on every PR touching `contracts/`, with a gas
report so a change that doubles a call's cost is visible in review.

---

# Track B · Platform & Release — @fatihmaull

### B1 · [#9](https://github.com/Fatihmaull/agent-holdem/issues/9) · CI pipeline — **P0** — 2d
Do this first. Four people on one repository without it is a broken `main`
within the week.

- On every pull request: install, `pnpm lint`, `pnpm test`, `pnpm build`.
- A Postgres service container so DB-backed tests can run when C4 lands.
- `pnpm test:contracts` when `contracts/` changed, with the forge-std submodule
  checked out.
- `main` protected: no direct pushes, CI green and one approval required.
- Under ten minutes, or people will start ignoring it.

**Blocks:** A6, C4, and the sanity of everyone's reviews.

### B2 · [#10](https://github.com/Fatihmaull/agent-holdem/issues/10) · Hosting and deploy — **P0** — 3d
- Deployed somewhere persistent, running **exactly one** engine process. The
  registry holds table state in memory: a second instance deals a second copy
  of every table and both write to the same database. Serverless and
  autoscaling are not options — write this constraint into the platform config
  so nobody enables it by accident later.
- Managed Postgres with backups that have been restored once, as a test.
- `pnpm db:migrate` runs as part of deploy, before the new process serves.
- Rolling back is documented and has been done once on staging.

### B3 · [#11](https://github.com/Fatihmaull/agent-holdem/issues/11) · Secrets management — **P0** — 1d
- `SESSION_SECRET`, `TREASURY_PRIVATE_KEY`, `GEMINI_API_KEYS` and
  `DATABASE_URL` come from the platform's secret store. None is in the repo, a
  developer's `.env`, or a build artefact.
- Staging and production have different values for all of them, especially the
  treasury.
- Rotating `SESSION_SECRET` logs everyone out — say so where someone about to
  do it will read it.

### B4 · [#12](https://github.com/Fatihmaull/agent-holdem/issues/12) · Staging environment — **P1** — 2d
- Its own database, its own vault, its own treasury with a small balance.
- Deploys from `main` automatically.
- Safe to lose. Anything that only exists on staging is not a backup.

### B5 · [#13](https://github.com/Fatihmaull/agent-holdem/issues/13) · Monitoring and error tracking — **P1** — 2d
Right now there are three `console` calls in the whole server and no error
tracking at all.

- Unhandled errors reach somewhere a person actually looks.
- The health check reports whether the engine is dealing, not merely whether
  the process answers a request.
- An uptime check that pages someone.
- Structured logs with a request or hand identifier, so one bad hand can be
  traced without grepping a container.

### B6 · [#14](https://github.com/Fatihmaull/agent-holdem/issues/14) · Repository hygiene — **P1** — 0.5d
- Branch protection on `main` requiring CI and one approval.
- *Automatically delete head branches* enabled — we cleaned up by hand once
  already, and the git relay refuses ref deletions from some environments.
- A pull request template pointing at the Definition of Done.
- `CODEOWNERS` mapping the four tracks, so reviews land on the right person.

---

# Track C · Engine & Reliability — *TBA*

### C1 · [#15](https://github.com/Fatihmaull/agent-holdem/issues/15) · Graceful shutdown and restart recovery — **P0** — 3d
Today `bootEngine` calls `stopTables()` on SIGTERM and that is the whole story.
A deploy in the middle of a hand is untested.

- SIGTERM stops new hands, lets the current one finish within a bounded time,
  then exits.
- A hand killed anyway leaves chips correct: a hand is only recorded when
  complete, so establish by test that an interrupted one costs nobody anything.
- On boot, tables reload seats and resume. No seat is stranded and no stack is
  duplicated.
- What a deploy does to a live table is written down for the person pressing
  the button.

### C2 · [#16](https://github.com/Fatihmaull/agent-holdem/issues/16) · Rate limiting and abuse control — **P1** — 3d
Eighteen API routes, none limited.

- Per-account and per-IP limits on every write route.
- A ceiling on model spend that no number of signups can cross.
- Signing up, deploying and leaving in a loop cannot exhaust the treasury, the
  model quota or the table roster.
- Limits return a clear error, not a hang.

### C3 · [#17](https://github.com/Fatihmaull/agent-holdem/issues/17) · Model provider hardening — **P1** — 2d
- A rate-limited or failing key rotates out instead of stalling a seat. The
  queue already holds several keys; make failure move to the next one.
- A provider outage degrades to the documented fallback — check when checking
  is free, fold when facing a bet — and says so in the decision record, which
  is already what `decisionOutcome` is for.
- Timeout and error rates per provider are visible in the metrics from B5.

### C4 · [#18](https://github.com/Fatihmaull/agent-holdem/issues/18) · Integration tests against a real database — **P1** — 3d
Every test today is pure. Nothing covers `actions.ts`, which is where the
money is.

- A suite against a real Postgres covering: join, leave, deploy to several
  tables, deposit credit, redemption, and the one-seat-per-wallet rule.
- Runs in CI with the service container from B1.
- Kept out of the default `pnpm test` or gated behind a flag, so a contributor
  without Docker is not blocked. Say which in the README.

### C5 · [#19](https://github.com/Fatihmaull/agent-holdem/issues/19) · Engine property tests — **P2** — 2d
- Randomised hands asserting chip conservation, no negative stacks, and pots
  summing to what was staked.
- Side pot construction against known awkward cases: mismatched all-ins, folded
  contributors, odd chips.

### C6 · [#20](https://github.com/Fatihmaull/agent-holdem/issues/20) · The multi-process question — **P2** — 1d, decision only
Table state living in one process is a real ceiling. Write the decision down:
either shard tables across processes with explicit ownership, or state the
capacity of one process and the point at which this has to change. A written
"not yet, and here is why" is a finished ticket.

---

# Track D · Product & Frontend — *TBA*

### D1 · [#21](https://github.com/Fatihmaull/agent-holdem/issues/21) · First-run onboarding — **P0** — 3d
A visitor arriving today gets a lobby and no explanation.

- The signed-out landing says what this is in a sentence someone who has never
  heard of it understands.
- Testnet-only, no real money, stated where it cannot be missed.
- How to get testnet tBNB, linked, because without it nothing else is possible.
- The path is obvious: connect → buy chips → write instructions → deploy →
  watch.
- Someone outside the team is put in front of it and gets to a seated agent
  without being told what to do. That is the acceptance test.

### D2 · [#22](https://github.com/Fatihmaull/agent-holdem/issues/22) · Mobile and accessibility — **P1** — 3d
- Every page usable at 390px. Opened on a phone, not merely narrowed in a
  browser.
- Keyboard navigable end to end with visible focus.
- Contrast checked against the dark palette.
- The felt degrades sensibly on a small screen rather than requiring a pinch.

### D3 · [#23](https://github.com/Fatihmaull/agent-holdem/issues/23) · Error and empty states — **P1** — 2d
- Every failure a user can hit says what happened and what to do next: RPC
  down, wallet rejected, table full, instructions too long, no free agent, out
  of chips.
- No blank panel that leaves someone wondering whether it is loading.
- Nothing new in the browser console.

### D4 · [#24](https://github.com/Fatihmaull/agent-holdem/issues/24) · Brain Visualizer polish — **P1** — 2d
This is the thing that makes the product interesting; it should be the most
finished screen we have.

- Reasoning streams legibly as it arrives.
- A timeout or an error is shown as itself, never dressed up as a fold —
  `decisionOutcome` already records the difference, so surface it.
- Equity, the price being offered and the action are readable at a glance,
  including for someone who does not play poker.

### D5 · [#25](https://github.com/Fatihmaull/agent-holdem/issues/25) · Hand replay — **P2** — 3d
Hands are already stored whole, with the seed, the board, the events and every
decision. A replayer is a client-side scrubber over data we have.

- Step through a finished hand with the reasoning shown at each decision.
- Linkable, so a good hand can be shared.

### D6 · [#26](https://github.com/Fatihmaull/agent-holdem/issues/26) · Agent leaderboard — **P2** — 2d
Ranking across accounts by the record already tracked on `agents`. Wait for
D1 — a leaderboard nobody can find is not worth building.

---

## Not doing yet

Named so nobody quietly starts one:

- **Mainnet.** Testnet only until the peg has been exercised for real.
- **Payout scaling by word budget.** Interesting, and it changes the economics
  of every table. Not before launch.
- **Template marketplace.** Needs a way to run a brief without revealing it,
  which is a project of its own.
- **More rooms or formats.** Six tables is enough to prove the idea. Each one
  is a live loop in the single process.
- **Rewriting the engine for multiple processes.** C6 decides *whether*, not
  now.

## Tracking

Every story below is filed as an issue: [#3 to #26](https://github.com/Fatihmaull/agent-holdem/issues).
Track A is assigned to @lagxy, Track B to @fatihmaull. Tracks C and D carry the
`needs-owner` label until the other two developers are named.

Filter by `track:chain`, `track:platform`, `track:engine`, `track:product`, or
by `P0` / `P1` / `P2`.

## Keeping this honest

This file is the plan of record. When a story is done, tick it here in the same
pull request that finishes it. When something turns out to be wrong — an
estimate, an owner, a whole ticket — change it and say why. A backlog nobody
edits is a backlog nobody reads.
