/**
 * `pnpm treasury` — can the vault still pay everybody out?
 *
 * The number that matters is not the balance, it is the balance against what is
 * owed. Ten thousand chips in circulation is 0.1 tBNB the operator has promised
 * to hand back on demand, and a peg that cannot be redeemed is not a peg.
 *
 * Exits non-zero below `TREASURY_MIN_BNB` so a scheduler can page somebody
 * while there is still time to top it up — which is the whole point. An alert
 * that fires after redemptions have started failing has told you nothing you
 * would not have learned from the support inbox.
 */
import 'dotenv/config';
import { sql } from '../db/client';
import { chipsToWei, formatBnb, formatChips } from '../lib/economy';
import { treasuryBalanceWei, vaultAddress, vaultConfigured } from '../server/chain';
import { reconcile } from '../server/reconcile';

/** Floor, in whole tBNB, below which this exits non-zero. */
const MIN_BNB = Number(process.env.TREASURY_MIN_BNB ?? 0.5);

async function main(): Promise<void> {
  if (!vaultConfigured()) {
    console.error('NEXT_PUBLIC_CHIP_VAULT_ADDRESS is not set: there is no vault to check.');
    process.exitCode = 1;
    return;
  }

  const [balance, report] = await Promise.all([treasuryBalanceWei(), reconcile()]);
  const owed = chipsToWei(report.inCirculation);
  const floor = BigInt(Math.round(MIN_BNB * 1e18));

  console.log(`vault           ${vaultAddress()}`);
  console.log(`balance         ${formatBnb(balance)} tBNB`);
  console.log(`chips out       ${formatChips(report.inCirculation)}`);
  console.log(`owed if all     ${formatBnb(owed)} tBNB`);
  console.log(
    `coverage        ${owed === 0n ? '∞' : `${((Number(balance) / Number(owed)) * 100).toFixed(0)}%`}`,
  );
  console.log('');

  const problems: string[] = [];
  if (balance < floor) problems.push(`the balance is under the ${MIN_BNB} tBNB floor`);
  if (owed > 0n && balance < owed) {
    problems.push('the vault holds less than it would owe if everybody redeemed at once');
  }

  if (problems.length === 0) {
    console.log('✓ the vault can cover every chip in circulation');
    return;
  }

  for (const problem of problems) console.error(`✗ ${problem}`);
  console.error('\nTop it up before redemptions start failing. docs/RUNBOOK.md § The treasury is running low.');
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
