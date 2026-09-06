/**
 * Chip purchase tiers.
 *
 * Chips are entirely decoupled from prompt length: a player buys bankroll up
 * front, then spends it as table buy-ins. `priceTbnb` is the testnet anchor
 * price used by the deploy script; the authoritative value always lives in
 * the deployed `PokerEscrow` contract (`tierPrice(tier)`), so the UI reads it
 * back on chain rather than trusting these constants for payment.
 */
export interface ChipTier {
  /** On-chain tier id, 1..4. Matches `buyChips(uint8 tier)`. */
  readonly id: 1 | 2 | 3 | 4;
  readonly key: 'starter' | 'grinder' | 'highRoller' | 'whale';
  readonly label: string;
  /** Nominal USD anchor, for display only. */
  readonly usd: number;
  /** Default testnet price in tBNB, used at deploy time. */
  readonly priceTbnb: string;
  readonly chips: number;
  readonly blurb: string;
}

export const CHIP_TIERS: readonly ChipTier[] = [
  {
    id: 1,
    key: 'starter',
    label: 'Starter',
    usd: 1,
    priceTbnb: '0.0015',
    chips: 100,
    blurb: 'Kick the tyres on a micro table.',
  },
  {
    id: 2,
    key: 'grinder',
    label: 'Grinder',
    usd: 10,
    priceTbnb: '0.015',
    chips: 1_000,
    blurb: 'Enough bankroll to deploy across three rooms.',
  },
  {
    id: 3,
    key: 'highRoller',
    label: 'High Roller',
    usd: 50,
    priceTbnb: '0.075',
    chips: 5_000,
    blurb: 'Sit deep in Tactical and Deep Strategy rooms.',
  },
  {
    id: 4,
    key: 'whale',
    label: 'Whale',
    usd: 100,
    priceTbnb: '0.15',
    chips: 10_000,
    blurb: 'Fleet deployment. Every table, every mode.',
  },
] as const;

export const TIER_BY_ID: Readonly<Record<number, ChipTier>> = Object.fromEntries(
  CHIP_TIERS.map((t) => [t.id, t]),
);

/**
 * Wei-per-chip implied by a tier. All four tiers are configured at deploy time
 * to the same rate so that buy price and withdraw price agree.
 */
export function chipsForTier(tier: number): number {
  const t = TIER_BY_ID[tier];
  if (!t) throw new Error(`Unknown chip tier: ${tier}`);
  return t.chips;
}
