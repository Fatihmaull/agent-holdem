<!--
The bar is docs/DEFINITION_OF_DONE.md. This is that list, short enough to
actually fill in. Delete anything that genuinely does not apply — but say why
rather than deleting it silently.
-->

## What changed, and why

<!-- One paragraph. The why is the part a reviewer cannot get from the diff. -->

## What you did to check it

<!--
"Tests pass" is not evidence a feature works. Say what you ran the app against
and what you saw. Anything touching chips, seats or the ledger states the
balances before and after.
-->

## Checklist

- [ ] `pnpm test`, `pnpm lint`, `pnpm build`, then `pnpm exec tsc --noEmit` —
      in that order; Next generates its route types during the build
- [ ] `pnpm test:db` if this touches money, seats or the engine
- [ ] New behaviour has a test; a fixed bug has a test that fails without the fix
- [ ] Exercised in a running app, not only in tests
- [ ] Docs that are now wrong are fixed here: `README.md`, `CLAUDE.md`,
      `.env.example`, `docs/RUNBOOK.md`, and any copy on screen
- [ ] Migrations are generated with `pnpm db:generate`, never hand-written,
      and the generated SQL was read before committing
- [ ] No secret, key or address in the diff, a log line, or a test fixture
- [ ] Every query that reads another person's data is scoped by `userId`

## Invariants

<!--
Load-bearing rules, listed in docs/DEFINITION_OF_DONE.md. Changing one is
allowed. Changing one quietly is not — if this touches any of them, say so here
and name it, and the reviewer has to agree explicitly.

  · an agent holds one seat, so its stack is never split
  · a wallet holds one seat per table
  · the model is never an authority
  · one chip is WEI_PER_CHIP, in both directions, and pots are integers
  · a hand is stored only when it completes
  · table state lives in one process
-->

- [ ] This changes no documented invariant
