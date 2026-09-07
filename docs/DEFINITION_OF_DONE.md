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
- [ ] A deposit is credited **without the browser staying open**. Sending tBNB
      and closing the tab must still result in chips.
- [ ] A redemption either pays out or is recorded as failed with the chips
      returned. A `PayoutUncertain` has a written procedure and a person who
      owns running it.
- [ ] The treasury key is not in the repo, not in a developer's `.env`, and not
      recoverable from a build artefact.
- [ ] Chip totals reconcile: for every account, `users.chips` plus its seat
      stacks equals the sum of its ledger entries. Checked by a script, not by
      eye.

### It stays up

- [ ] Deployed somewhere persistent, running **exactly one** engine process.
      The registry keeps table state in memory, so a second instance deals a
      second copy of every table. Autoscaling and serverless are not options
      until that changes.
- [ ] A restart is graceful: no hand is lost mid-deal, or if one is, chips are
      unaffected and the table resumes.
- [ ] Health check that reports whether the engine is dealing, not just whether
      the process answers.
- [ ] Errors reach somewhere a human looks. Not `console.error` in a container
      nobody tails.

### It cannot be trivially abused

- [ ] Write endpoints are rate limited per account and per IP.
- [ ] Model spend has a ceiling that cannot be crossed by anyone signing up and
      deploying agents.
- [ ] A signed-out visitor can reach nothing that costs money or reveals
      another player's cards.

### It can be worked on

- [ ] CI runs `pnpm test`, `pnpm lint`, `pnpm build` and `pnpm test:contracts`
      on every pull request, and `main` is protected behind it.
- [ ] A new contributor can go from clone to dealing tables using only
      `README.md`. Verified by someone who has not done it before.

### It explains itself

- [ ] A first-time visitor understands what the product is, that it is testnet
      only with no real money, and how to get testnet tBNB — without asking.
- [ ] Every failure a user can hit says what happened and what to do next.
- [ ] Usable on a phone, and keyboard-navigable.

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
- A wallet holds at most one seat per table, so nobody plays both sides of a
  hand and nobody sees two sets of hole cards.
- The model is never an authority: equity and legal moves are settled before it
  is asked, and its reply is validated after.
- One chip is `WEI_PER_CHIP` in both directions. Pots and balances are integers
  and never touch a float.
- Table state lives in one process.

Changing one of these is allowed. Changing one quietly is not.
