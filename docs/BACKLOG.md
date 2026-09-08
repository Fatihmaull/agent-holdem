# Backlog — getting to a usable product

The bar is in [`DEFINITION_OF_DONE.md`](./DEFINITION_OF_DONE.md): a stranger
with a wallet and testnet tBNB can arrive, buy chips, deploy an agent, watch it
play and cash out, and none of it depends on one of us being awake.

## Where we actually are

Everything on this side of a wallet and a host is done. The engine, the agent
loop, the money paths, the reliability work, the abuse controls and the
interface are built and tested; CI runs the lot on every pull request.

**Two things are left, and neither is code.**

1. **`ChipVault` has never been deployed** (A1). Until it is,
   `NEXT_PUBLIC_CHIP_VAULT_ADDRESS` is empty and the cashier cannot take a
   deposit — tables still deal, but nobody outside this repository can obtain
   a chip. It needs a funded wallet and a deliberate choice of owner.
2. **There is nowhere to run it** (B2). One process, managed Postgres, the
   secrets in a store. `docs/DEPLOY.md` is the order to do it in and the
   settings that are not optional.

The rehearsals in `docs/DEPLOY.md` — restoring a backup, rolling back once,
and putting a stranger in front of the interface — are also somebody's to do,
because the point of each is the rehearsal.

What was blocking before and is not any more:

- Deposits are credited from the chain by a watcher, so paying and closing the
  tab still results in chips (A2).
- A payout that goes quiet has a procedure, a script and a runbook (A3).
- `pnpm reconcile` proves no chip was invented or lost, nightly (A4).
- CI, rate limiting, graceful restart, key rotation, monitoring and the
  interface work are done. Ticked below.

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

**Not done — needs a funded wallet.** `pnpm test:contracts` is green in CI and `docs/DEPLOY.md` § 1 is the checklist. Everything downstream of it is built and waiting.
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

**Done.** A watcher scans the vault’s `Deposited` logs from a stored cursor and credits from the event itself. Sixteen tests over a real database, including the same hash twice and two callers racing.
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

**Done.** All three outcomes are tested; `pnpm redemptions` triages what is left and `docs/RUNBOOK.md` § A payout is stuck is the procedure.
Paying out is the half of the peg we have never exercised.

- A failed payout returns the chips; verified by test, not by reading the code.
- `PayoutUncertain` — sent but unconfirmed — has a written procedure: how to
  tell whether it landed, and what to do either way. Written where an on-call
  person will find it, not in a commit message.
- A script lists redemptions needing a human decision.
- The 5% fee is shown to the user before they confirm, and matches what the
  contract takes.

### A4 · [#6](https://github.com/Fatihmaull/agent-holdem/issues/6) · Chip reconciliation script — **P1** — 2d

**Done.** `pnpm reconcile`, nightly in `.github/workflows/nightly.yml`. The invariant in the Definition of Done was wrong and was corrected — see `src/server/reconcile.ts`.
Proof that we have not invented or lost chips.

- `pnpm reconcile` checks, for every account: `users.chips` plus its seat
  stacks equals the sum of its ledger entries.
- Reports the drift per account and exits non-zero if any exists.
- Runs nightly in CI once B1 exists, and fails loudly.

### A5 · [#7](https://github.com/Fatihmaull/agent-holdem/issues/7) · Treasury key handling and balance alerting — **P1** — 1d

**Code done, the drill is not.** `pnpm treasury` reports coverage and fails before payouts do; rotation is written up in `docs/RUNBOOK.md`. Doing it once as a rehearsal is still somebody’s job.
- The key lives only in the deploy platform's secret store. Rotation is
  documented and has been done once as a drill.
- An alert fires while the treasury still has enough tBNB to pay out, not after
  redemptions have started failing.
- The runbook says who tops it up and from where.

### A6 · [#8](https://github.com/Fatihmaull/agent-holdem/issues/8) · Contract tests in CI — **P2** — 1d

**Done.** `forge test` plus a gas report on every pull request.
Depends on **B1**. `forge test` on every PR touching `contracts/`, with a gas
report so a change that doubles a call's cost is visible in review.

---

# Track B · Platform & Release — @fatihmaull

### B1 · [#9](https://github.com/Fatihmaull/agent-holdem/issues/9) · CI pipeline — **P0** — 2d

**Done.** Lint, tests, database tests, a migration against an empty database, reconciliation, build and typecheck, plus contracts. Under ten minutes.
Do this first. Four people on one repository without it is a broken `main`
within the week.

- On every pull request: install, `pnpm lint`, `pnpm test`, `pnpm build`.
- A Postgres service container so DB-backed tests can run when C4 lands.
- `forge test` with the forge-std submodule checked out. Runs on **every** pull
  request rather than only when `contracts/` changed: a required check that is
  skipped never reports, and the pull request then waits forever on a check
  that will never arrive. The suite is small enough that this costs less than
  the trap.
- `main` protected: no direct pushes, CI green and one approval required.
- Under ten minutes, or people will start ignoring it.

**Blocks:** A6, C4, and the sanity of everyone's reviews.

### B2 · [#10](https://github.com/Fatihmaull/agent-holdem/issues/10) · Hosting and deploy — **P0** — 3d

**Artefacts done, the deploy is not.** Dockerfile, standalone output and `docs/DEPLOY.md`, including the settings that are not optional: one instance, a grace period above the drain, and the health check pointed at `/api/health`.
- Deployed somewhere persistent, running **exactly one** engine process. The
  registry holds table state in memory: a second instance deals a second copy
  of every table and both write to the same database. Serverless and
  autoscaling are not options — write this constraint into the platform config
  so nobody enables it by accident later.
- Managed Postgres with backups that have been restored once, as a test.
- `pnpm db:migrate` runs as part of deploy, before the new process serves.
- Rolling back is documented and has been done once on staging.

### B3 · [#11](https://github.com/Fatihmaull/agent-holdem/issues/11) · Secrets management — **P0** — 1d

**Documented, not provisioned.** `.env.example` lists every variable; `docs/DEPLOY.md` § 2 says which are secrets and what each one costs if it leaks, including the `.env`-in-a-layer trap.
- `SESSION_SECRET`, `TREASURY_PRIVATE_KEY`, `GEMINI_API_KEYS` and
  `DATABASE_URL` come from the platform's secret store. None is in the repo, a
  developer's `.env`, or a build artefact.
- Staging and production have different values for all of them, especially the
  treasury.
- Rotating `SESSION_SECRET` logs everyone out — say so where someone about to
  do it will read it.

### B4 · [#12](https://github.com/Fatihmaull/agent-holdem/issues/12) · Staging environment — **P1** — 2d

**Documented, not provisioned.** `docs/DEPLOY.md` § 6.
- Its own database, its own vault, its own treasury with a small balance.
- Deploys from `main` automatically.
- Safe to lose. Anything that only exists on staging is not a backup.

### B5 · [#13](https://github.com/Fatihmaull/agent-holdem/issues/13) · Monitoring and error tracking — **P1** — 2d

**Done.** Structured logs with an event name and flat fields, `ERROR_WEBHOOK_URL` for anything that needs a person, and `/api/health` reporting whether the engine is dealing rather than whether the process answers.
Right now there are three `console` calls in the whole server and no error
tracking at all.

- Unhandled errors reach somewhere a person actually looks.
- The health check reports whether the engine is dealing, not merely whether
  the process answers a request.
- An uptime check that pages someone.
- Structured logs with a request or hand identifier, so one bad hand can be
  traced without grepping a container.

### B6 · [#14](https://github.com/Fatihmaull/agent-holdem/issues/14) · Repository hygiene — **P1** — 0.5d

**Done.** Pull request template, CODEOWNERS by track. Branch protection is on; *Automatically delete head branches* is the remaining click.
- Branch protection on `main` requiring CI and one approval.
- *Automatically delete head branches* enabled — we cleaned up by hand once
  already, and the git relay refuses ref deletions from some environments.
- A pull request template pointing at the Definition of Done.
- `CODEOWNERS` mapping the four tracks, so reviews land on the right person.

---

# Track C · Engine & Reliability — *TBA*

### C1 · [#15](https://github.com/Fatihmaull/agent-holdem/issues/15) · Graceful shutdown and restart recovery — **P0** — 3d

**Done.** A drain is separate from an abort, `NEXT_MANUAL_SIG_HANDLE` takes the signals off Next, and there is a test that an interrupted hand costs a hand and no chips.
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

**Done.** Every write route goes through `guard()`, counted per account and per address, with a structural test that fails when a new route forgets.
Eighteen API routes, none limited.

- Per-account and per-IP limits on every write route.
- A ceiling on model spend that no number of signups can cross.
- Signing up, deploying and leaving in a loop cannot exhaust the treasury, the
  model quota or the table roster.
- Limits return a clear error, not a hang.

### C3 · [#17](https://github.com/Fatihmaull/agent-holdem/issues/17) · Model provider hardening — **P1** — 2d

**Done.** A failing key rotates out and backs off; `AGENT_DAILY_REQUEST_CAP` is the ceiling on spend.
- A rate-limited or failing key rotates out instead of stalling a seat. The
  queue already holds several keys; make failure move to the next one.
- A provider outage degrades to the documented fallback — check when checking
  is free, fold when facing a bet — and says so in the decision record, which
  is already what `decisionOutcome` is for.
- Timeout and error rates per provider are visible in the metrics from B5.

### C4 · [#18](https://github.com/Fatihmaull/agent-holdem/issues/18) · Integration tests against a real database — **P1** — 3d

**Done.** Sixty tests over Postgres under `pnpm test:db`, kept out of `pnpm test`. Said so in the README.
Every test today is pure. Nothing covers `actions.ts`, which is where the
money is.

- A suite against a real Postgres covering: join, leave, deploy to several
  tables, deposit credit, redemption, and the one-seat-per-wallet rule.
- Runs in CI with the service container from B1.
- Kept out of the default `pnpm test` or gated behind a flag, so a contributor
  without Docker is not blocked. Say which in the README.

### C5 · [#19](https://github.com/Fatihmaull/agent-holdem/issues/19) · Engine property tests — **P2** — 2d

**Done.** About 1,500 randomised hands plus the awkward side-pot cases, asserting conservation after every action.
- Randomised hands asserting chip conservation, no negative stacks, and pots
  summing to what was staked.
- Side pot construction against known awkward cases: mismatched all-ins, folded
  contributors, odd chips.

### C6 · [#20](https://github.com/Fatihmaull/agent-holdem/issues/20) · The multi-process question — **P2** — 1d, decision only

**Done.** `docs/DECISIONS.md` § 1: not yet, with the measurements, and the three things that would make it wrong.
Table state living in one process is a real ceiling. Write the decision down:
either shard tables across processes with explicit ownership, or state the
capacity of one process and the point at which this has to change. A written
"not yet, and here is why" is a finished ticket.

---

# Track D · Product & Frontend — *TBA*

### D1 · [#21](https://github.com/Fatihmaull/agent-holdem/issues/21) · First-run onboarding — **P0** — 3d

**Done.** A testnet notice on every screen with the faucet linked, and "How it works" is the whole path rather than the interesting middle of it.
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

**Done.** Opened at 390px in a real browser: no horizontal scroll and no console errors on home, the lobby, a live table, the editor, a replay or the leaderboard. Tabbed through four pages — the skip link comes first, every focused element draws a visible outline. Contrast measured across the whole palette: every text token clears AA on every background it is actually used on, and `surface-3` is only ever a hover state or a progress track, never a background for text.
- Every page usable at 390px. Opened on a phone, not merely narrowed in a
  browser.
- Keyboard navigable end to end with visible focus.
- Contrast checked against the dark palette.
- The felt degrades sensibly on a small screen rather than requiring a pinch.

### D3 · [#23](https://github.com/Fatihmaull/agent-holdem/issues/23) · Error and empty states — **P1** — 2d

**Done.** Wallet failures say what happened and whether anything was spent; empty states explain themselves.
- Every failure a user can hit says what happened and what to do next: RPC
  down, wallet rejected, table full, instructions too long, no free agent, out
  of chips.
- No blank panel that leaves someone wondering whether it is loading.
- Nothing new in the browser console.

### D4 · [#24](https://github.com/Fatihmaull/agent-holdem/issues/24) · Brain Visualizer polish — **P1** — 2d

**Done.** Equity and the price are on screen as two comparable bars, and a timeout is labelled as itself next to the action.
This is the thing that makes the product interesting; it should be the most
finished screen we have.

- Reasoning streams legibly as it arrives.
- A timeout or an error is shown as itself, never dressed up as a fold —
  `decisionOutcome` already records the difference, so surface it.
- Equity, the price being offered and the action are readable at a glance,
  including for someone who does not play poker.

### D5 · [#25](https://github.com/Fatihmaull/agent-holdem/issues/25) · Hand replay — **P2** — 3d

**Done.** `/hand/[id]`, linkable and steppable, built from the stored events so a mucked hand stays mucked.
Hands are already stored whole, with the seed, the board, the events and every
decision. A replayer is a client-side scrubber over data we have.

- Step through a finished hand with the reasoning shown at each decision.
- Linkable, so a good hand can be shared.

### D6 · [#26](https://github.com/Fatihmaull/agent-holdem/issues/26) · Agent leaderboard — **P2** — 2d

**Done.** `/leaderboard`, ranked by net chips with a twenty-hand minimum.
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
