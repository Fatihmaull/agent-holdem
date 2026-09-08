# Definition of Done

Three levels. A **change** is one pull request. A **story** is one backlog
item, which may take several pull requests. A **release** is the whole thing
being fit for someone who is not us to use.

Nothing here is aspirational. If a rule is not being followed, either the work
is not done or the rule is wrong and we change it deliberately.

---

## 1. A change is done when…

Every pull request, no exceptions, including one-line fixes.

**It runs**

- [ ] `pnpm test` passes. New behaviour has a test; a fixed bug has a test that
      fails without the fix.
- [ ] `pnpm lint` passes with no new suppressions.
- [ ] `pnpm build` succeeds.
- [ ] `pnpm exec tsc --noEmit` is clean. Run it **after** `pnpm build`: Next
      generates the `RouteContext`, `PageProps` and `LayoutProps` types during
      a build, so running it first shows five errors that mean nothing. CI runs
      it in that order and expects zero.
- [ ] CI is green. A red check is not "done with a known failure" — it is not
      done.

**It was actually tried**

- [ ] The change was exercised in a running app, not only in tests. Say in the
      PR what you did and what you saw. "Tests pass" is not evidence that a
      feature works.
- [ ] Anything touching chips, seats or the ledger states the balances before
      and after. Chip arithmetic that is not shown to reconcile is not done.

**It fits the codebase**

- [ ] Follows `CLAUDE.md`. In particular: `src/poker` and `src/lib` stay pure,
      only `src/server` touches Postgres or the chain, and API routes stay thin
      — parse, get a session, call one action, translate `ActionError`.
- [ ] Migrations are generated (`pnpm db:generate`), never hand-written. The
      generated SQL is read before it is committed.
- [ ] `src/server/vault-abi.ts` is regenerated with `pnpm abi` after any
      contract change, never edited.
- [ ] Comments explain *why*, not *what*. Match the surrounding density.
- [ ] No duplicated type that a shared one would cover. A hand-copied interface
      typechecks perfectly while silently drifting from what the API returns —
      this has already bitten us once.

**It is safe**

- [ ] User-written text (instructions, drafts, table talk) is treated as
      untrusted everywhere it is read, stored or shown.
- [ ] Every query that reads or writes another person's data is scoped by
      `userId`. Cross-account access was tested, not assumed.
- [ ] No secret, key or address in the diff, in a log line, or in a test
      fixture.
- [ ] A new invariant that matters is enforced by the database or by a lock,
      not by a check that two concurrent requests can both pass.

**It is reviewed**

- [ ] One approval from someone who did not write it. The PR body says what
      changed, why, and what was verified.
- [ ] A change that alters a documented invariant says so at the top of the PR
      and names the invariant. Reviewer has to agree explicitly.

---

## 2. A story is done when…

On top of every rule above.

- [ ] The acceptance criteria in the backlog item are all met, and the ones
      that were dropped are written down with the reason.
- [ ] Docs that are now wrong are fixed in the same PR — `README.md`,
      `CLAUDE.md`, `.env.example`, and any copy in the interface. Stale docs
      are a defect, not a follow-up.
- [ ] The failure path was tried, not just the happy path. What does a user see
      when the RPC is down, the model times out, the table is full, the wallet
      rejects?
- [ ] It works on a phone. Not "responsive-ish" — actually opened at 390px and
      used.
- [ ] Nothing new appears in the browser console.

---

## 3. The release is done when…

This is the bar for "100% ready to use": a stranger with a wallet and testnet
tBNB can arrive, buy chips, deploy an agent, watch it play and cash out, and
nothing about that experience depends on one of us being awake.

### Money is safe

- [ ] `ChipVault` is deployed to BNB testnet, verified on BscScan, and its
      address is in the deployed environment.
- [x] A deposit is credited without the browser staying open: a watcher scans
      the vault's logs from a stored cursor. Still needs doing for real once
      the vault exists — `docs/DEPLOY.md` § 5, step 3.
- [ ] A redemption either pays out or is recorded as failed with the chips
      returned. A `PayoutUncertain` has a written procedure and a person who
      owns running it — `docs/RUNBOOK.md` § A payout is stuck, and
      `pnpm redemptions` lists what is waiting on one.
- [ ] The treasury key is not in the repo, not in a developer's `.env`, and not
      recoverable from a build artefact.
- [ ] `pnpm reconcile` is clean, and runs nightly. It checks the three things
      that are actually true: every chip in circulation was issued by a
      deposit, every balance equals the sum of that account's ledger entries,
      and every table holds exactly what was bought into it less what was
      cashed out.

      This used to read "for every account, `users.chips` plus its seat stacks
      equals the sum of its ledger entries", which is false and would have
      failed on any healthy table. Winning a pot moves chips between two seats
      and writes no ledger entry, because nothing entered or left an account;
      and a buy-in writes a negative delta while the chips still exist, sitting
      on a table. The ledger records chips crossing the boundary of an account,
      not chips coming into being. `src/server/reconcile.ts` states the correct
      version at the top.

### It stays up

- [ ] Deployed somewhere persistent, running **exactly one** engine process.
      The artefacts are ready — `Dockerfile`, `docs/DEPLOY.md` — and the
      constraint is written next to the setting it applies to.
      The registry keeps table state in memory, so a second instance deals a
      second copy of every table. Autoscaling and serverless are not options
      until that changes.
- [x] A restart is graceful: SIGTERM stops new hands, lets the ones in flight
      finish inside `SHUTDOWN_DRAIN_MS`, then exits. A hand cut off anyway
      costs a hand and no chips, established by test rather than by argument.
      Needs `NEXT_MANUAL_SIG_HANDLE=1`, which the Dockerfile sets.
- [x] `/api/health` reports whether the engine is dealing, whether the deposit
      watcher is sweeping, and whether the model key pool is alive — not just
      whether the process answers.
- [x] Errors reach somewhere a human looks: structured logs, and
      `ERROR_WEBHOOK_URL` for anything that needs a person. The four events
      that mean somebody's money is waiting are listed in `docs/DEPLOY.md` § 7,
      each with a section in the runbook.

### It cannot be trivially abused

- [x] Every write endpoint goes through `guard()`, limited per account and per
      address, with a structural test that fails when a new route forgets.
- [x] `AGENT_DAILY_REQUEST_CAP` is a hard ceiling on model requests across
      every table and every account. Past it, seats fall back to check-or-fold
      — a bad game rather than an unbounded invoice.
- [ ] A signed-out visitor can reach nothing that costs money or reveals
      another player's cards.

### It can be worked on

- [x] CI runs `pnpm lint`, `pnpm test`, `pnpm test:db`, `pnpm db:migrate`,
      `pnpm reconcile`, `pnpm build`, `pnpm exec tsc --noEmit` and
      `pnpm test:contracts` on every pull request, and `main` is protected
      behind it.
- [ ] A new contributor can go from clone to dealing tables using only
      `README.md`. Verified by someone who has not done it before.

### It explains itself

- [ ] A first-time visitor understands what the product is, that it is testnet
      only with no real money, and how to get testnet tBNB — without asking.
- [x] Every failure a user can hit says what happened, what to do next, and
      whether anything was spent.
- [x] Usable on a phone and keyboard-navigable: opened at 390px, tabbed
      through, and the palette measured against every background it is used
      on.

---

## How we work

**Branches.** `main` is protected and always deployable. Work happens on
`type/short-description` — `feat/`, `fix/`, `chore/`, `docs/`. Delete the
branch after merge; turn on *Settings → General → Automatically delete head
branches* so it happens by itself.

**Pull requests.** Small and single-purpose. If a PR needs a table of contents
it should have been three PRs. Merge with a merge commit when the history is
worth keeping, squash when it is not.

**Reviews.** One approval to merge. The author does not approve their own work.
Reviewing is not optional work you get to when free — a PR sitting unreviewed
for a day is a blocked teammate.

**Invariants.** Some rules in this codebase are load-bearing and written down
where they are enforced:

- An agent holds exactly one seat, so its stack is never split.
- A hand is stored only when it completes, and stacks are only written from a
  stored hand. An interrupted hand is discarded whole, which is what makes a
  restart mid-deal cost a hand rather than chips.
- A deposit is credited from the chain, never from a client's word, and never
  twice: the credit is conditioned on the intent still being pending, under a
  lock on that row.
- A wallet holds at most one seat per table, so nobody plays both sides of a
  hand and nobody sees two sets of hole cards.
- The model is never an authority: equity and legal moves are settled before it
  is asked, and its reply is validated after.
- One chip is `WEI_PER_CHIP` in both directions. Pots and balances are integers
  and never touch a float.
- Table state lives in one process.

Changing one of these is allowed. Changing one quietly is not.
