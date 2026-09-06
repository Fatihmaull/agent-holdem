import hre from 'hardhat';
import { formatEther, parseEther } from 'viem';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import deployConfig from '../deploy.config.json';

/**
 * Deploys PokerEscrow.
 *
 * The arbiter defaults to the deployer so a local run works with no setup;
 * for BNB testnet set ARBITER_ADDRESS to the backend's signing wallet, since
 * that is the only account allowed to settle tables.
 */
async function main() {
  const [deployer] = await hre.viem.getWalletClients();
  if (!deployer) throw new Error('No wallet configured. Set DEPLOYER_PRIVATE_KEY.');

  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const arbiter = (process.env.ARBITER_ADDRESS ?? deployer.account.address) as `0x${string}`;

  const prices = deployConfig.tiers.map((t) => parseEther(t.priceTbnb)) as [
    bigint, bigint, bigint, bigint,
  ];
  const chips = deployConfig.tiers.map((t) => BigInt(t.chips)) as [
    bigint, bigint, bigint, bigint,
  ];

  // Every tier is priced at the same rate per chip; the redemption rate is
  // derived from the anchor tier so buying and cashing out cannot drift.
  const anchor = deployConfig.tiers.find((t) => t.id === deployConfig.weiPerChipFromTier);
  if (!anchor) throw new Error('weiPerChipFromTier does not match any configured tier');
  const weiPerChip = parseEther(anchor.priceTbnb) / BigInt(anchor.chips);

  console.log(`Deploying PokerEscrow to chain ${chainId}`);
  console.log(`  deployer: ${deployer.account.address}`);
  console.log(`  arbiter:  ${arbiter}`);
  console.log(`  weiPerChip: ${weiPerChip} (${formatEther(weiPerChip)} tBNB)`);

  const escrow = await hre.viem.deployContract('PokerEscrow', [
    arbiter,
    prices,
    chips,
    weiPerChip,
  ]);

  console.log(`\nPokerEscrow deployed at ${escrow.address}`);
  for (const tier of deployConfig.tiers) {
    const [price, tierChipCount] = await escrow.read.quoteTier([tier.id]);
    console.log(`  tier ${tier.id}: ${formatEther(price)} tBNB → ${tierChipCount} chips`);
  }

  // The contract needs a tBNB reserve before anyone can cash chips out. Chip
  // purchases fund it naturally; RESERVE_TBNB pre-funds it for a demo.
  const reserve = process.env.RESERVE_TBNB;
  if (reserve && Number(reserve) > 0) {
    const hash = await deployer.sendTransaction({
      to: escrow.address,
      value: parseEther(reserve),
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  seeded withdrawal reserve with ${reserve} tBNB`);
  }

  const record = {
    chainId,
    address: escrow.address,
    arbiter,
    deployer: deployer.account.address,
    weiPerChip: weiPerChip.toString(),
    tiers: deployConfig.tiers,
    deployedAt: new Date().toISOString(),
  };

  const outDir = resolve(__dirname, '../deployments');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    resolve(outDir, `${chainId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );

  console.log('\nAdd these to your .env:');
  console.log(`  POKER_ESCROW_ADDRESS=${escrow.address}`);
  console.log(`  NEXT_PUBLIC_POKER_ESCROW_ADDRESS=${escrow.address}`);
  console.log(`  CHAIN_SETTLEMENT_ENABLED=true`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
