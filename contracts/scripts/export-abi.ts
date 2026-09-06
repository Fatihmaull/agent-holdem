import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import artifact from '../artifacts/contracts/PokerEscrow.sol/PokerEscrow.json';

/**
 * Copies the compiled ABI into the shared package so the server and the web
 * app consume one checked-in artifact instead of each maintaining a
 * hand-written copy that silently drifts from the contract.
 */
const target = resolve(__dirname, '../../packages/shared/src/escrowAbi.ts');

const banner = `/**
 * GENERATED FILE — do not edit by hand.
 * Produced by \`npm run export-abi -w @agentholdem/contracts\` from
 * contracts/contracts/PokerEscrow.sol.
 */

`;

writeFileSync(
  target,
  `${banner}export const POKER_ESCROW_ABI = ${JSON.stringify(artifact.abi, null, 2)} as const;\n`,
  'utf8',
);

console.log(`Wrote ABI (${artifact.abi.length} entries) to ${target}`);
