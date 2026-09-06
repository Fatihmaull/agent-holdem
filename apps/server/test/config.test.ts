import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEther } from 'viem';
import { describe, expect, it } from 'vitest';
import { CHIP_TIERS, POKER_ESCROW_ABI, ROOM_MODES } from '@agentholdem/shared';

/**
 * These guard the seams where the same numbers live in more than one place.
 * A tier price that drifts between the deploy script and the UI is the kind
 * of bug that only shows up as a failed transaction on a live testnet.
 */
describe('cross-package configuration', () => {
  const deployConfig = JSON.parse(
    readFileSync(resolve(__dirname, '../../../contracts/deploy.config.json'), 'utf8'),
  ) as { tiers: { id: number; priceTbnb: string; chips: number }[]; weiPerChipFromTier: number };

  it('deploy config matches the shared chip tiers', () => {
    expect(deployConfig.tiers).toHaveLength(CHIP_TIERS.length);
    for (const tier of CHIP_TIERS) {
      const row = deployConfig.tiers.find((t) => t.id === tier.id);
      expect(row, `tier ${tier.id} missing from deploy.config.json`).toBeDefined();
      expect(row!.priceTbnb).toBe(tier.priceTbnb);
      expect(row!.chips).toBe(tier.chips);
    }
  });

  it('prices every tier at the same rate per chip', () => {
    const rates = CHIP_TIERS.map((t) => parseEther(t.priceTbnb) / BigInt(t.chips));
    for (const rate of rates) expect(rate).toBe(rates[0]);
  });

  it('keeps the USD anchor proportional to the chip count', () => {
    for (const tier of CHIP_TIERS) {
      expect(tier.chips).toBe(tier.usd * 100);
    }
  });

  it('exports the contract surface the server and web app depend on', () => {
    const names = POKER_ESCROW_ABI.filter((e) => e.type === 'function').map(
      (e) => (e as { name: string }).name,
    );
    for (const required of [
      'buyChips',
      'lockChipsForTable',
      'settleTable',
      'settleTableMulti',
      'withdrawChips',
      'refundTable',
      'userChipBalance',
      'quoteTier',
      'tableInfo',
    ]) {
      expect(names, `ABI is missing ${required}`).toContain(required);
    }
  });

  it('exposes exactly the three word-limit rooms from the spec', () => {
    expect(ROOM_MODES.map((m) => m.wordLimit)).toEqual([10, 50, 100]);
  });
});
