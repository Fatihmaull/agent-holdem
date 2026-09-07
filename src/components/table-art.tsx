/* eslint-disable @next/next/no-img-element */
import { colorById } from '@/agent/colors';

/**
 * The physical objects on the felt. The cards and the seat marker are the actual
 * art from `public/cards` and `public/chips`, not a CSS approximation of it.
 *
 * Money is deliberately not among them. A chip tower says roughly how much is
 * there and never says exactly, which is the wrong trade at a table where the
 * amount of a bet is the whole story; stacks and bets are figures instead, and
 * live in the arena beside the seat they belong to.
 *
 * These use plain `<img>` on purpose. The card and chip files are already small
 * fixed-size PNGs served from our own origin, so routing them through the image
 * optimiser would add work and cache pressure without changing a byte that
 * reaches the browser.
 */

const CARD_RATIO = 630 / 420;

/**
 * Where a card came from, as an offset in pixels from where it ends up.
 *
 * A seat hands back the vector to the middle of the table, so its cards are
 * dealt out of the middle instead of dropping into place, and the same vector
 * run the other way is where the hand goes when it is mucked. Anything with no
 * particular origin passes nothing and keeps the plain drop.
 */
export interface CardOrigin {
  x: number;
  y: number;
}

export interface CardMotion {
  delayMs?: number;
  origin?: CardOrigin | null;
  /** `reveal` turns the card face up; `deal` slides it in from `origin`. */
  entrance?: 'deal' | 'reveal';
  /** The hand is out of play and on its way back to the middle. */
  leaving?: boolean;
}

function motionClass({ entrance = 'deal', leaving = false }: CardMotion): string {
  if (leaving) return 'mucked';
  return entrance === 'reveal' ? 'revealed' : 'dealt';
}

function motionStyle({ delayMs = 0, origin }: CardMotion): React.CSSProperties {
  // Custom properties are not in React's CSS type, and the alternative is a
  // prop per direction wired through every caller for the same two numbers.
  const style: Record<string, string> = { animationDelay: `${delayMs}ms` };
  if (origin) {
    style['--deal-x'] = `${Math.round(origin.x)}px`;
    style['--deal-y'] = `${Math.round(origin.y)}px`;
  }
  return style as React.CSSProperties;
}

export function PlayingCard({
  card,
  size = 84,
  dimmed = false,
  ...motion
}: CardMotion & {
  card: string;
  size?: number;
  dimmed?: boolean;
}) {
  return (
    <img
      src={`/cards/${card}.png`}
      alt={cardLabel(card)}
      width={size}
      height={Math.round(size * CARD_RATIO)}
      className={`${motionClass(motion)} block rounded-[6px] shadow-[0_10px_22px_-10px_rgba(0,0,0,0.85)]`}
      style={{ ...motionStyle(motion), opacity: dimmed ? 0.45 : 1 }}
      draggable={false}
    />
  );
}

export function CardBack({
  size = 84,
  dimmed = false,
  ...motion
}: CardMotion & { size?: number; dimmed?: boolean }) {
  return (
    <img
      src="/cards/back.png"
      alt="Face down"
      width={size}
      height={Math.round(size * CARD_RATIO)}
      className={`${motionClass(motion)} block rounded-[6px] shadow-[0_10px_22px_-10px_rgba(0,0,0,0.85)]`}
      style={{ ...motionStyle(motion), opacity: dimmed ? 0.4 : 1 }}
      draggable={false}
    />
  );
}

/**
 * A board position no card has reached yet. It marks the place without
 * pretending to be an object: a dashed outline the size of a card reads as five
 * empty boxes on the felt, which is louder than the cards that eventually fill
 * them.
 */
export function CardSlot({ size = 84 }: { size?: number }) {
  return (
    <div
      className="rounded-[6px] bg-black/15"
      style={{ width: size, height: Math.round(size * CARD_RATIO) }}
      aria-hidden
    />
  );
}

/** The seat marker in the lobby and beside a name. One chip, seen from above. */
export function ChipDot({ color, size = 18, empty = false }: { color?: string | null; size?: number; empty?: boolean }) {
  if (empty || !color) {
    return (
      <span
        className="inline-block rounded-full border border-dashed border-white/25"
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }
  return (
    <img
      src={`/chips/${color}-top.png`}
      alt=""
      width={size}
      height={size}
      className="inline-block align-middle"
      draggable={false}
    />
  );
}

export function DealerButton({ size = 22 }: { size?: number }) {
  return <img src="/chips/dealer-top.png" alt="Dealer" width={size} height={size} draggable={false} />;
}

/** Falls back to the interface accent, so an unowned bar still looks deliberate. */
export function agentHex(color: string | null | undefined): string {
  return color ? colorById(color).hex : '#17b26a';
}

const RANK_WORDS: Record<string, string> = {
  A: 'Ace',
  K: 'King',
  Q: 'Queen',
  J: 'Jack',
  T: 'Ten',
};

const SUIT_WORDS: Record<string, string> = {
  s: 'spades',
  h: 'hearts',
  d: 'diamonds',
  c: 'clubs',
};

function cardLabel(card: string): string {
  const rank = RANK_WORDS[card[0]] ?? card[0];
  return `${rank} of ${SUIT_WORDS[card[1]] ?? card[1]}`;
}
