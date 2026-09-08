/**
 * `pnpm reconcile` — does the chip ledger still add up?
 *
 * Run it nightly and after anything that touched money. It exits non-zero on
 * any drift, so a scheduler or a CI job fails loudly rather than writing a
 * reassuring line into a log nobody reads.
 */
import 'dotenv/config';
import { reconcile } from '../server/reconcile';
import { sql } from '../db/client';
import { formatChips } from '../lib/economy';

async function main(): Promise<void> {
  const report = await reconcile();

  console.log(`accounts          ${report.accounts}`);
  console.log(`in balances       ${formatChips(report.balances)} chips`);
  console.log(`on tables         ${formatChips(report.stacks)} chips`);
  console.log(`in circulation    ${formatChips(report.inCirculation)} chips`);
  console.log(`ever issued       ${formatChips(report.issued)} chips`);
  console.log(`ledger total      ${formatChips(report.ledger)} chips`);
  console.log('');

  if (report.drifts.length === 0) {
    console.log('✓ every chip is accounted for');
    return;
  }

  console.error(`✗ ${report.drifts.length} discrepanc${report.drifts.length === 1 ? 'y' : 'ies'}:`);
  for (const drift of report.drifts) {
    console.error(`\n  ${drift.scope}`);
    console.error(`    expected ${formatChips(drift.expected)}, found ${formatChips(drift.actual)}`);
    console.error(`    ${drift.detail}`);
  }
  console.error('\ndocs/RUNBOOK.md explains what to do about each of these.');
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
