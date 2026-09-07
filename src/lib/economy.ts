/**
 * Chips are the unit of play. They are a fixed peg on tBNB, not a separate
 * currency: one chip is always worth 0.00001 tBNB, in both directions. All
 * balances and pots are integer chip counts, so no pot arithmetic ever touches
 * a float or a wei value.
 */

/** Wei backing a single chip. 0.00001 tBNB. */
export const WEI_PER_CHIP = 10_000_000_000_000n;

/** Share of a redemption kept by the house, in basis points. */
const REDEMPTION_FEE_BPS = 500n; // 5%

/**
 * tBNB has no market price, so the Cashier's dollar figures come from this
 * fixed notional rate rather than an oracle. The interface says so on screen.
 */
const NOTIONAL_USD_PER_BNB = 600;

export function chipsToWei(chips: number): bigint {
  if (!Number.isInteger(chips) || chips < 0) throw new Error(`not a chip amount: ${chips}`);
  return BigInt(chips) * WEI_PER_CHIP;
}

/** Rounds down. A deposit that does not fill a whole chip buys nothing. */
export function weiToChips(wei: bigint): number {
  if (wei < 0n) throw new Error('negative wei');
  return Number(wei / WEI_PER_CHIP);
}

export interface Redemption {
  chips: number;
  grossWei: bigint;
  feeWei: bigint;
  /** What the player actually receives on chain. */
  netWei: bigint;
}

export function quoteRedemption(chips: number): Redemption {
  const grossWei = chipsToWei(chips);
  const feeWei = (grossWei * REDEMPTION_FEE_BPS) / 10_000n;
  return { chips, grossWei, feeWei, netWei: grossWei - feeWei };
}

export interface ChipPackage {
  id: string;
  name: string;
  chips: number;
  popular?: boolean;
}

export const CHIP_PACKAGES: ChipPackage[] = [
  { id: 'starter', name: 'Starter', chips: 10_000 },
  { id: 'regular', name: 'Regular', chips: 50_000, popular: true },
  { id: 'whale', name: 'Whale', chips: 250_000 },
];

export function packageById(id: string): ChipPackage | undefined {
  return CHIP_PACKAGES.find((entry) => entry.id === id);
}

/** Display helpers. Formatting lives here so chips read the same on every screen. */
export function formatChips(chips: number): string {
  return chips.toLocaleString('en-US');
}

export function formatBnb(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

export function formatUsd(wei: bigint): string {
  const bnb = Number(wei) / 1e18;
  return (bnb * NOTIONAL_USD_PER_BNB).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

export type TableFormat = 'heads-up' | '4-max' | '6-max';

export interface TableConfig {
  /** Engine and URL identifier, `t-01`. Never shown to a player. */
  id: string;
  number: number;
  format: TableFormat;
  seats: number;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
}

const SEATS_FOR: Record<TableFormat, number> = { 'heads-up': 2, '4-max': 4, '6-max': 6 };

function makeTable(number: number, format: TableFormat, smallBlind: number, buyIn: number): TableConfig {
  return {
    id: `t-${String(number).padStart(2, '0')}`,
    number,
    format,
    seats: SEATS_FOR[format],
    smallBlind,
    bigBlind: smallBlind * 2,
    buyIn,
  };
}

/**
 * A fixed roster, as the lobby in the specification describes: permanent tables
 * at every format and stake, with agents taking open seats.
 */
export const TABLES: TableConfig[] = [
  makeTable(1, 'heads-up', 10, 2_000),
  makeTable(2, 'heads-up', 50, 10_000),
  makeTable(3, '4-max', 10, 2_000),
  makeTable(4, '4-max', 50, 10_000),
  makeTable(5, '6-max', 50, 10_000),
  makeTable(6, '6-max', 250, 50_000),
];

export function tableById(id: string): TableConfig | undefined {
  return TABLES.find((table) => table.id === id);
}

/**
 * Tables are named by the two things a player actually chooses between: how
 * many opponents, and how much a hand costs. The `t-01` identifier stays in the
 * URL because the engine keys on it, but it is never shown as a name.
 */
export function tableLabel(table: TableConfig): string {
  return `${formatLabel(table.format)} ${stakesLabel(table)}`;
}

const FORMAT_LABELS: Record<TableFormat, string> = {
  'heads-up': 'Heads-Up',
  '4-max': '4-Max',
  '6-max': '6-Max',
};

function formatLabel(format: TableFormat): string {
  return FORMAT_LABELS[format];
}

/** How many opponents the format means, in words, for anyone new to the game. */
const FORMAT_BLURBS: Record<TableFormat, string> = {
  'heads-up': 'One opponent',
  '4-max': 'Up to three opponents',
  '6-max': 'Up to five opponents',
};

export function formatBlurb(format: TableFormat): string {
  return FORMAT_BLURBS[format];
}

function stakesLabel(table: TableConfig): string {
  return `${table.smallBlind}/${table.bigBlind}`;
}

/** The stake filter's options, derived from the roster so the two cannot drift. */
export function stakeOptions(): string[] {
  const seen = new Map<number, string>();
  for (const table of TABLES) seen.set(table.smallBlind, stakesLabel(table));
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, label]) => label);
}
