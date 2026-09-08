# Runbook

What to do when something involving money or the match engine goes wrong.
Written for whoever is on call, including the version of yourself who has not
looked at this code for a month.

Every procedure here assumes you have `DATABASE_URL` and `BSC_TESTNET_RPC_URL`
pointed at the environment you are fixing. Read the whole procedure before
running any of it. Nothing below should be improvised: the failures that cost a
user money are the ones where somebody guessed.

**The one rule.** Never give chips back for a payout you have not proven was
never made. A redemption that is paid on chain and refunded in the database
hands the same person their tBNB and their chips. Every "am I sure?" in this
file is that rule again.

---

## Contents

- [A payout is stuck — `redemption.uncertain`](#a-payout-is-stuck)
- [A deposit was paid but not credited — `deposit.paid-but-uncredited`](#a-deposit-was-paid-but-not-credited)
- [Two deposits in one transaction — `deposit.conflict`](#two-deposits-in-one-transaction)
- [The deposit watcher has stopped — `deposit.sweep-failed`](#the-deposit-watcher-has-stopped)
- [Reconciliation reports drift](#reconciliation-reports-drift)
- [The treasury is running low](#the-treasury-is-running-low)
- [Rotating a secret](#rotating-a-secret)
- [Deploying while tables are live](#deploying-while-tables-are-live)
- [The health check is red](#the-health-check-is-red)

---

## A payout is stuck

**You will see:** an `redemption.uncertain` error, a support message about tBNB
that never arrived, or a row from `pnpm redemptions`.

**What it means.** `redeem` debited the chips, broadcast a payout, and then
never saw a receipt. The transaction may be mined a minute later or may never
land. The chips stay spent, deliberately, because refunding a payout that
afterwards succeeds pays it twice.

### 1. Ask the vault

```bash
pnpm redemptions
```

Each row carries a verdict, and the verdict comes from `redemptionPaid` on the
contract — not from a receipt, not from a mempool, from the vault's own record
of what it has paid. It is the authority.

| Verdict | What it means | What to do |
| --- | --- | --- |
| `paid` | The vault paid it. The chips were correctly spent; only the row is stale. | `pnpm redemptions --settle` |
| `in-flight` | Broadcast, and the vault has not paid it. | Step 2 |
| `never-sent` | Debited but nothing was ever broadcast. | Step 3 |
| `unknown` | The RPC could not be reached. | Fix the RPC, then start again. Change nothing. |

### 2. `in-flight` — look the transaction up

Open the hash on [BscScan testnet](https://testnet.bscscan.com). One of three
things is true:

- **Success.** The vault will now say `paid`. Re-run `pnpm redemptions
  --settle` and you are done.
- **Reverted.** Nothing was paid and nothing ever will be under that hash.
  Treat it as `never-sent` and go to step 3.
- **Not found, or still pending.** Wait. A transaction can sit in the mempool
  for a long time on a quiet testnet, and this is exactly the case where
  refunding is dangerous. Come back in an hour. Only once the nonce has been
  used by a *different* transaction is the original one certain to be dead.

### 3. `never-sent` or definitively dead — return the chips

```bash
pnpm redemptions --refund <redemption-id>
```

This asks the vault one more time before it writes anything, so a stale listing
cannot be used to refund something that has since landed. It returns the chips,
writes an `adjustment` entry to the ledger, and marks the redemption `failed`.

### 4. Confirm

```bash
pnpm reconcile
```

Should be clean. If it is not, go to [Reconciliation reports
drift](#reconciliation-reports-drift).

### Tell the player

They watched their balance drop and got nothing. Say which of the two happened
— "your tBNB is on its way, here is the transaction" or "the payout failed and
your chips are back". Do not leave them guessing; that is worse than the outage.

---

## A deposit was paid but not credited

**You will see:** `deposit.paid-but-uncredited`. The sweep tried to write off an
old intent, asked the vault whether it had been consumed, and the vault said
yes. Somebody paid and has no chips.

The row is left `pending` on purpose so this is recoverable.

1. Find the deposit on chain. The intent id in the log line maps to the
   contract's `bytes32` by the padding in `src/lib/intent.ts`; the vault's
   `Deposited` event carries the payer and the amount.
2. If the transaction hash is known, the fastest fix is to write it onto the
   row and let the watcher chase it:

   ```sql
   update deposit_intents set tx_hash = '0x…' where id = '…' and status = 'pending';
   ```

   The next sweep picks it up through the hash path and credits it normally,
   with all the usual checks. Prefer this over crediting by hand.
3. If the payer's address does not match the account that requested the intent,
   stop. Somebody paid against somebody else's deposit request, and who the
   chips belong to is a decision, not a script.
4. Never insert a ledger entry by hand without also updating `users.chips` in
   the same transaction. `pnpm reconcile` will catch you, which is the point,
   but the account is wrong until you do.

---

## Two deposits in one transaction

**You will see:** `deposit.conflict`.

One transaction carried `Deposited` events for two different intents. The
`tx_hash` column is unique — that uniqueness is what makes a replay impossible —
so only the first intent can hold it. The second is a real deposit that cannot
be credited automatically.

This needs a person because the automatic fix would mean weakening the
uniqueness that protects every other deposit. Credit it by hand, in one
transaction, and reference the same hash in the ledger entry:

```sql
begin;
update deposit_intents set status = 'credited', credited_at = now()
  where id = '<second intent>' and status = 'pending';
update users set chips = chips + <chips> where id = '<user>';
insert into ledger_entries (user_id, delta, balance_after, reason, reference)
  values ('<user>', <chips>, (select chips from users where id = '<user>'), 'deposit', '<tx hash>');
commit;
```

Then `pnpm reconcile`.

---

## The deposit watcher has stopped

**You will see:** `deposit.sweep-failed` repeatedly, or `/api/health` returning
503 with `deposits.ok = false`.

Deposits are not being credited without a browser. Players who leave the tab
open are still fine, which is why this can go unnoticed.

1. The error text on the log line says which of the two it is: the RPC or the
   database.
2. RPC: check `BSC_TESTNET_RPC_URL`. Public endpoints rate-limit, and the sweep
   asks for logs every twenty seconds. A dedicated endpoint is the fix.
3. Database: see whether the app is serving at all. If it is, the sweep is
   failing on something specific — read the error rather than restarting.
4. Nothing is lost while it is down. The cursor only advances over ranges that
   were fully processed, so when it comes back it re-reads everything it
   missed. Restarting is safe.

---

## Reconciliation reports drift

```bash
pnpm reconcile
```

Exits non-zero and names each discrepancy. There are four shapes:

**`system` — in circulation does not match ever issued.** Chips exist that no
deposit paid for, or chips vanished that no redemption took. This is the
serious one. Do not "fix" the balance: find the transaction that wrote it.
`select * from ledger_entries order by id desc limit 50` and look for an entry
without a matching deposit or redemption, or a balance change with no entry.

**`system` — balances do not add up to the ledger.** Something wrote
`users.chips` without a ledger entry in the same transaction. Every such write
in the codebase is in `actions.ts`, `store.ts`, `deposits.ts` or
`settlement.ts`; the bug is a new path that skipped one. The account-level
drifts below name who is affected.

**`account …`** — one balance disagrees with its own ledger. The ledger is the
record: the balance is what should be corrected, with an `adjustment` entry
saying so, never the other way round.

**`table …`** — the stacks at a table do not equal what was bought in less what
was cashed out. Either a hand paid out more than was staked, which is an engine
bug and should be reproducible from the stored hand's seed, or a seat was
written without a buy-in. Take the table out of the roster before investigating
if it is still dealing.

Run `pnpm reconcile` nightly. A drift found the morning after is a bug; a drift
found a month later is an archaeology project.

---

## The treasury is running low

```bash
pnpm treasury
```

Prints the vault's balance and what it would take to cover every chip currently
in circulation. It exits non-zero below `TREASURY_MIN_BNB`, so it can be run on
a schedule and page somebody.

**Top it up before redemptions start failing, not after.** A player whose payout
fails gets their chips back and a bad message; a player who cannot cash out at
all has been told the peg does not hold.

To top up, send tBNB to the vault address, or call `fund()` on it — either
works, the contract accepts plain transfers. Testnet tBNB comes from the [BNB
faucet](https://www.bnbchain.org/en/testnet-faucet).

The number to watch is coverage, not the raw balance: 10,000 chips outstanding
is 0.1 tBNB owed. Keep several times that.

---

## Rotating a secret

All of these live in the deploy platform's secret store, never in the
repository. `.env.example` lists them with no values.

**`SESSION_SECRET`** — rotating it invalidates every signed-in session. Everyone
is logged out and has to sign with their wallet again. Nothing is lost; no
chips move. Do it if you suspect it leaked, and tell people first if you can.

**`TREASURY_PRIVATE_KEY`** — the serious one. It signs payouts, so anyone with
it can drain the vault.

1. Generate a new key and fund the new address with enough tBNB.
2. `ChipVault` ownership is two-step: call `transferOwnership(new)` from the
   current owner, then `acceptOwnership()` from the new one. It is two steps
   precisely so a typo cannot leave the vault unowned — do not skip the second.
3. Update `TREASURY_PRIVATE_KEY` in the secret store and redeploy.
4. Run one small redemption end to end before considering it done.
5. Sweep the old address and retire it.

**`GEMINI_API_KEYS`** — comma-separated, and a failing key is rotated out of the
pool automatically, so keys can be replaced one at a time with no downtime. Add
the new one, deploy, remove the old one, deploy.

---

## Deploying while tables are live

A deploy interrupts hands in progress. What happens depends on one variable.

**With `NEXT_MANUAL_SIG_HANDLE=1`** (which is what the Dockerfile sets, and what
you want): on SIGTERM the engine stops dealing new hands, lets the ones in
flight finish — up to `SHUTDOWN_DRAIN_MS`, 45 seconds by default — and then
exits. Spectators see the hand play out and the table goes quiet.

**Without it:** Next installs its own signal handler and exits as soon as the
HTTP server closes, so hands are cut off mid-deal. The boot log says which mode
you are in: look for `gracefulShutdown` on the `engine.started` line.

**Set the platform's termination grace period above `SHUTDOWN_DRAIN_MS`.** If
the platform kills the container after 30 seconds and the drain is allowed 45,
the drain never finishes and you have configured a lie.

**Chips are safe either way.** A hand is only recorded when it completes, and
stacks are only written from a recorded hand. An interrupted hand is discarded
whole: every bet in it is undone and the stored stacks — which still hold every
chip that was in front of a seat — stand. The cost of a hard kill is a hand
that has to be replayed, not chips.

On restart, tables reload their seats from the database and continue hand
numbering from the highest already stored. Nothing is stranded and no stack is
duplicated.

---

## The health check is red

`GET /api/health` returns 503 when any of three things is wrong. The response
body names which.

**`database`** — the connection string, the database being down, or a
connection pool exhausted by something holding transactions open.

**`engine`** — either no table is dealing, which means the loop exited (look for
`table.stopped` in the logs and the error above it), or no hand has finished in
`HEALTH_STALL_AFTER_MS`. A stall with tables occupied usually means the model
provider is hanging; check `AGENT_PROVIDER` and the queue.

**`deposits`** — see [The deposit watcher has
stopped](#the-deposit-watcher-has-stopped).

A process that answers requests while its tables have stopped dealing is the
failure this check exists for. Nothing 500s, no request errors, and the product
is dead. Point an uptime check at this endpoint, not at `/`.
