/**
 * Chips are the unit of play. They are a fixed peg on the native token of
 * whichever chain a deposit settled on, not a separate currency: one chip is
 * always worth 0.00001 of it, in both directions. All balances and pots are
 * integer chip counts, so no pot arithmetic ever touches a float or a wei
 * value.
 *
 * The peg is deliberately the same number on every chain. Test tokens have no
 * market to price against each other, so a peg that varied by network would be
 * arbitrary and would make a pot mean different things on different networks.
 */

/** Wei backing a single chip. 0.00001 of the chain's native token. */
export const WEI_PER_CHIP = 10_000_000_000_000n;

/*
 * Chips go in and never come out.
 *
 * There is no function anywhere that turns a chip back into a token, and the
 * vault has no payout selector to call, so this is a property of the deployment
 * rather than a rule the operator keeps. What a chip buys is a seat and a place
 * on the record: winning one is worth exactly the standing it earns, which is
 * the whole reason the standings rank on a rating and not on a balance.
 */

export function chipsToWei(chips: number): bigint {
  if (!Number.isInteger(chips) || chips < 0) throw new Error(`not a chip amount: ${chips}`);
  return BigInt(chips) * WEI_PER_CHIP;
}

/** Rounds down. A deposit that does not fill a whole chip buys nothing. */
export function weiToChips(wei: bigint): number {
  if (wei < 0n) throw new Error('negative wei');
  return Number(wei / WEI_PER_CHIP);
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

/** Wei as a decimal amount of the native token, without a symbol. */
export function formatNative(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/**
 * A dollar hint for the Cashier, at the notional rate the chain carries.
 *
 * Test tokens have no market, so the rate is a fixed reference rather than an
 * oracle and the interface says so on screen. A chain with no plausible
 * reference price returns null and the figure is left off entirely rather than
 * invented.
 */
export function formatUsd(wei: bigint, notionalUsd: number | undefined): string | null {
  if (notionalUsd === undefined) return null;
  const tokens = Number(wei) / 1e18;
  return (tokens * notionalUsd).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

/**
 * The match.
 *
 * Every game in the arena is the same game: one blind level, one buy-in, the
 * same seats, the same length. That is not a simplification for its own sake.
 * A field this size cannot fill several stakes, and offering a choice of them
 * hands a well-funded agent a way to pick softer company, which is the exact
 * behaviour the arena exists to measure rather than to reward.
 */

/** Six-handed is where multiway pots live, which is where reading an opponent pays. */
export const MAX_SEATS = 6;

/**
 * Two is a game. Fewer is not.
 *
 * A match would rather start short than not start, because an empty queue
 * teaches nobody anything. The matchmaker holds briefly for a full table first.
 */
export const MIN_SEATS = 2;

export const SMALL_BLIND = 10;
export const BIG_BLIND = 20;

/**
 * How deep everyone sits, in big blinds.
 *
 * Deep enough that hands play past the flop, where reading an opponent actually
 * happens. Short-stacked poker collapses into a preflop shoving game, which is
 * the one part of hold'em that is already solved and the least interesting
 * thing an agent could be tested on.
 */
export const BUY_IN_BB = 100;
export const BUY_IN = BIG_BLIND * BUY_IN_BB;

/**
 * The house's cut, charged once at the door.
 *
 * Tournaments charge a fee to enter and never touch a pot, which is the right
 * model here and a better one than the pot rake this replaced. A fee is the
 * same for everybody, so it shifts every result by the same amount and reorders
 * nobody; a pot rake taxes contested pots, which charges an aggressive agent
 * more than a cautious one for the same quality of play. It is also the only
 * thing removing chips from the arena, so without it the supply would only ever
 * grow.
 */
export const ENTRY_FEE_BPS = 200;
export const ENTRY_FEE = Math.floor((BUY_IN * ENTRY_FEE_BPS) / 10_000);

/** What one seat costs an owner, all in. */
export const SEAT_COST = BUY_IN + ENTRY_FEE;

/**
 * How long a match runs when nobody busts.
 *
 * Blinds never rise, so something has to end it. A hundred hands costs each
 * agent around twenty-five big blinds in blinds alone, which is enough pressure
 * to punish folding without turning the endgame into a shoving contest. Shorter
 * matches also mean more finishing orders, and a rating converges on the number
 * of results rather than on the number of hands inside them.
 */
export const HAND_CAP = 100;

/** How many matches a new account is funded for. */
const GRANT_MATCHES = 3;

/**
 * What a new account starts with, and the figure a lapsed one is topped back
 * up to each day.
 *
 * An owner who has to buy chips before their agent can play has been asked to
 * pay to find out whether the thing works, and most will not. Three matches is
 * enough to see whether an agent is hopeless.
 *
 * The daily top-up is honest rather than generous while chips are bought with a
 * testnet token that costs nothing. It is the single line to remove if this
 * ever settles on a network where they do.
 */
export const STARTING_GRANT = SEAT_COST * GRANT_MATCHES;

export interface MatchConfig {
  seats: number;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  entryFee: number;
  handCap: number;
}

/** The one game on offer, as the engine and the screens both need it. */
export const MATCH: MatchConfig = {
  seats: MAX_SEATS,
  smallBlind: SMALL_BLIND,
  bigBlind: BIG_BLIND,
  buyIn: BUY_IN,
  entryFee: ENTRY_FEE,
  handCap: HAND_CAP,
};

/** How the stakes read on screen. One line, because there is only one game. */
export function stakesLabel(): string {
  return `${SMALL_BLIND}/${BIG_BLIND}`;
}

