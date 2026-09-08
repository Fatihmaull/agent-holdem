/**
 * `pnpm redemptions` — which payouts still need a person, and why.
 *
 *   pnpm redemptions                 list what is stuck and what the vault says
 *   pnpm redemptions --settle        close the ones the vault has already paid
 *   pnpm redemptions --refund <id>   return the chips for one that never went
 *
 * docs/RUNBOOK.md is the procedure this belongs to. Read it before refunding
 * anything: a redemption that looks abandoned and is actually in the mempool
 * will pay out after you have already given the chips back.
 */
import 'dotenv/config';
import { formatBnb, formatChips } from '../lib/economy';
import { sql } from '../db/client';
import { SettlementRefused, refundRedemption, settlePaid, stuckRedemptions } from '../server/settlement';

const EXPLAIN: Record<string, string> = {
  paid: 'the vault paid it — close it with --settle',
  'in-flight': 'broadcast, not yet paid. Look the hash up on BscScan before deciding',
  'never-sent': 'debited but never broadcast. --refund returns the chips',
  unknown: 'the chain could not be reached, so nothing is known yet',
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const refundAt = args.indexOf('--refund');
  if (refundAt >= 0) {
    const id = args[refundAt + 1];
    if (!id) throw new Error('--refund needs a redemption id');
    const result = await refundRedemption(id);
    console.log(`refunded ${formatChips(result.chips)} chips; the account now holds ${formatChips(result.balance)}`);
    return;
  }

  if (args.includes('--settle')) {
    const closed = await settlePaid();
    console.log(
      closed.length === 0
        ? 'nothing to settle: the vault has not paid any redemption still marked pending'
        : `settled ${closed.length}: ${closed.join(', ')}`,
    );
    return;
  }

  const stuck = await stuckRedemptions();
  if (stuck.length === 0) {
    console.log('✓ no redemption is waiting on a decision');
    return;
  }

  console.log(`${stuck.length} redemption${stuck.length === 1 ? '' : 's'} waiting on a decision:\n`);
  for (const row of stuck) {
    console.log(`  ${row.id}`);
    console.log(`    ${row.address}  ${formatChips(row.chips)} chips  ${formatBnb(BigInt(row.netWei))} tBNB`);
    console.log(`    raised ${row.createdAt.toISOString()}`);
    console.log(`    tx ${row.txHash ?? '(never broadcast)'}`);
    console.log(`    ${row.verdict}: ${EXPLAIN[row.verdict]}`);
    console.log('');
  }
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof SettlementRefused ? `refused: ${error.message}` : error);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
