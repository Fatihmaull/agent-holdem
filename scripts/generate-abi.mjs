import { readFileSync, writeFileSync } from 'node:fs';

const artifact = JSON.parse(readFileSync('contracts/out/ChipVault.sol/ChipVault.json', 'utf8'));
const banner = '// Generated from contracts/out/ChipVault.sol/ChipVault.json.\n// Regenerate after changing the contract: pnpm abi\n';
writeFileSync('src/server/vault-abi.ts', `${banner}export const chipVaultAbi = ${JSON.stringify(artifact.abi, null, 2)} as const;\n`);
console.log(`wrote ${artifact.abi.length} ABI entries`);
