import { type Card, fullDeck, mulberry32, shuffle } from './cards';
import { evaluate } from './evaluate';

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete';

export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise';

export interface Action {
  type: ActionType;
  /** For `bet` and `raise` this is the total this seat will have in front of it after acting. */
  to?: number;
}

export interface Seat {
  index: number;
  agentId: string;
  stack: number;
  /** Chips pushed forward during the current betting round. */
  committed: number;
  /** Chips pushed forward across the whole hand. Drives side pots. */
  contributed: number;
  hole: readonly [Card, Card] | null;
  folded: boolean;
  allIn: boolean;
  /** Seat is at the table but not in this hand. */
  sittingOut: boolean;
  hasActed: boolean;
  needsToAct: boolean;
  mayRaise: boolean;
}

export interface Pot {
  amount: number;
  /** Seat indexes entitled to contest this layer. */
  eligible: number[];
}

export interface HandState {
  handId: string;
  street: Street;
  seats: Seat[];
  button: number;
  smallBlind: number;
  bigBlind: number;
  board: Card[];
  deck: Card[];
  /** Seat that owes an action, or null between streets and at the end of the hand. */
  toAct: number | null;
  /** Largest amount any seat has committed this round. */
  currentBet: number;
  /** Size of the last full raise, which sets the minimum for the next one. */
  lastRaiseSize: number;
  pots: Pot[];
  events: HandEvent[];
}

export type HandEvent =
  | { type: 'hand-start'; handId: string; button: number; blinds: [number, number] }
  | { type: 'blind'; seat: number; kind: 'small' | 'big'; amount: number; allIn: boolean }
  | { type: 'hole-dealt'; seats: number[] }
  | { type: 'action'; seat: number; action: ActionType; amount: number; to: number; allIn: boolean }
  | { type: 'street'; street: Street; cards: Card[] }
  | { type: 'showdown'; seat: number; hole: readonly [Card, Card]; score: number }
  | { type: 'award'; seat: number; amount: number; potIndex: number; uncontested: boolean }
  | { type: 'hand-end'; stacks: Array<{ seat: number; stack: number }> };

export interface SeatConfig {
  agentId: string;
  stack: number;
  sittingOut?: boolean;
}

export interface HandOptions {
  handId: string;
  seats: SeatConfig[];
  button: number;
  smallBlind: number;
  bigBlind: number;
  seed?: number;
}

/** Deals a fresh hand and posts the blinds. Returns a state whose `toAct` is set. */
export function startHand(options: HandOptions): HandState {
  const { handId, seats: configs, button, smallBlind, bigBlind } = options;
  const random = options.seed === undefined ? Math.random : mulberry32(options.seed);

  const seats: Seat[] = configs.map((config, index) => ({
    index,
    agentId: config.agentId,
    stack: config.stack,
    committed: 0,
    contributed: 0,
    hole: null,
    folded: config.sittingOut === true || config.stack <= 0,
    allIn: false,
    sittingOut: config.sittingOut === true || config.stack <= 0,
    hasActed: false,
    needsToAct: false,
    mayRaise: true,
  }));

  const live = seats.filter((seat) => !seat.sittingOut);
  if (live.length < 2) throw new Error('a hand needs at least two funded seats');

  const state: HandState = {
    handId,
    street: 'preflop',
    seats,
    button,
    smallBlind,
    bigBlind,
    board: [],
    deck: shuffle(fullDeck(), random),
    toAct: null,
    currentBet: 0,
    lastRaiseSize: bigBlind,
    pots: [],
    events: [{ type: 'hand-start', handId, button, blinds: [smallBlind, bigBlind] }],
  };

  // Heads-up puts the button on the small blind and out of position after the flop.
  const headsUp = live.length === 2;
  const smallSeat = headsUp ? button : nextLive(state, button);
  const bigSeat = nextLive(state, smallSeat);

  postBlind(state, smallSeat, smallBlind, 'small');
  postBlind(state, bigSeat, bigBlind, 'big');
  state.currentBet = bigBlind;

  for (const seat of live) {
    seat.hole = [state.deck.pop()!, state.deck.pop()!] as [Card, Card];
    seat.needsToAct = !seat.allIn;
  }
  state.events.push({ type: 'hole-dealt', seats: live.map((seat) => seat.index) });

  state.toAct = nextToAct(state, bigSeat);
  // Blinds alone can put every live seat all in, leaving nobody to act. The
  // hand is still a hand: the board has to run out before anyone can win it.
  if (state.toAct === null) runOut(state);
  return state;
}

function postBlind(state: HandState, index: number, amount: number, kind: 'small' | 'big'): void {
  const seat = state.seats[index];
  const posted = Math.min(amount, seat.stack);
  seat.stack -= posted;
  seat.committed += posted;
  seat.contributed += posted;
  if (seat.stack === 0) seat.allIn = true;
  state.events.push({ type: 'blind', seat: index, kind, amount: posted, allIn: seat.allIn });
}

function nextLive(state: HandState, from: number): number {
  const count = state.seats.length;
  for (let step = 1; step <= count; step++) {
    const index = (from + step) % count;
    if (!state.seats[index].sittingOut) return index;
  }
  throw new Error('no live seat');
}

/** Next seat clockwise that still owes an action, or null if the round is done. */
function nextToAct(state: HandState, from: number): number | null {
  const count = state.seats.length;
  for (let step = 1; step <= count; step++) {
    const seat = state.seats[(from + step) % count];
    if (seat.needsToAct && !seat.folded && !seat.allIn) return seat.index;
  }
  return null;
}

export interface LegalActions {
  fold: boolean;
  check: boolean;
  call: number | null;
  /** Opening bet range, when nobody has bet this round. */
  bet: { min: number; max: number } | null;
  /** Raise range expressed as the total to have in front of you. */
  raise: { min: number; max: number } | null;
  toCall: number;
  potSize: number;
}

export function legalActions(state: HandState): LegalActions | null {
  if (state.toAct === null) return null;
  const seat = state.seats[state.toAct];
  const toCall = Math.min(state.currentBet - seat.committed, seat.stack);
  const potSize = totalPot(state);

  const canAggress = seat.mayRaise && seat.stack > toCall;
  const minRaiseTo = state.currentBet + Math.max(state.lastRaiseSize, state.bigBlind);
  const maxTo = seat.committed + seat.stack;

  return {
    // Folding a free hand is not offered. It is never right, and an agent that
    // does it by accident looks broken rather than creative.
    fold: toCall > 0,
    check: toCall === 0,
    call: toCall > 0 ? toCall : null,
    bet: state.currentBet === 0 && canAggress ? { min: Math.min(state.bigBlind, maxTo), max: maxTo } : null,
    raise: state.currentBet > 0 && canAggress ? { min: Math.min(minRaiseTo, maxTo), max: maxTo } : null,
    toCall,
    potSize,
  };
}

export function totalPot(state: HandState): number {
  return state.seats.reduce((sum, seat) => sum + seat.contributed, 0);
}

export class IllegalAction extends Error {}

/** Applies one action and advances the hand as far as it can go without another decision. */
export function applyAction(state: HandState, action: Action): HandState {
  if (state.toAct === null) throw new IllegalAction('no seat is to act');
  const legal = legalActions(state)!;
  const seat = state.seats[state.toAct];

  switch (action.type) {
    case 'fold': {
      if (!legal.fold) throw new IllegalAction('cannot fold when checking is free');
      seat.folded = true;
      record(state, seat, 'fold', 0);
      break;
    }
    case 'check': {
      if (!legal.check) throw new IllegalAction(`cannot check facing ${legal.toCall}`);
      record(state, seat, 'check', 0);
      break;
    }
    case 'call': {
      if (legal.call === null) throw new IllegalAction('nothing to call');
      commit(seat, legal.call);
      record(state, seat, 'call', legal.call);
      break;
    }
    case 'bet':
    case 'raise': {
      const range = action.type === 'bet' ? legal.bet : legal.raise;
      if (!range) throw new IllegalAction(`cannot ${action.type} here`);
      const to = action.to ?? range.min;
      if (to < range.min || to > range.max) {
        throw new IllegalAction(`${action.type} to ${to} is outside ${range.min}..${range.max}`);
      }

      const raiseSize = to - state.currentBet;
      const amount = to - seat.committed;
      commit(seat, amount);

      const fullRaise = raiseSize >= Math.max(state.lastRaiseSize, state.bigBlind);
      state.currentBet = to;
      if (fullRaise) state.lastRaiseSize = raiseSize;

      // Everyone still in owes a response. A short all-in reopens the action only
      // for seats that had not acted yet; seats that already acted may call, not raise.
      for (const other of state.seats) {
        if (other === seat || other.folded || other.allIn || other.sittingOut) continue;
        if (!fullRaise && other.hasActed) other.mayRaise = false;
        else other.mayRaise = true;
        other.needsToAct = true;
      }

      record(state, seat, action.type, amount, to);
      break;
    }
  }

  seat.hasActed = true;
  seat.needsToAct = false;
  advance(state, seat.index);
  return state;
}

function commit(seat: Seat, amount: number): void {
  const paid = Math.min(amount, seat.stack);
  seat.stack -= paid;
  seat.committed += paid;
  seat.contributed += paid;
  if (seat.stack === 0) seat.allIn = true;
}

function record(state: HandState, seat: Seat, action: ActionType, amount: number, to?: number): void {
  state.events.push({
    type: 'action',
    seat: seat.index,
    action,
    amount,
    to: to ?? seat.committed,
    allIn: seat.allIn,
  });
}

function contenders(state: HandState): Seat[] {
  return state.seats.filter((seat) => !seat.folded && !seat.sittingOut);
}

function advance(state: HandState, from: number): void {
  if (contenders(state).length === 1) {
    settle(state);
    return;
  }

  const next = nextToAct(state, from);
  if (next !== null) {
    state.toAct = next;
    return;
  }

  // Betting round complete.
  for (const seat of state.seats) {
    seat.committed = 0;
    seat.hasActed = false;
    seat.mayRaise = true;
  }
  state.currentBet = 0;
  state.lastRaiseSize = state.bigBlind;

  const canStillBet = contenders(state).filter((seat) => !seat.allIn).length;
  const nextStreet = followingStreet(state.street);

  if (nextStreet === 'showdown') {
    dealTo(state, 'showdown');
    settle(state);
    return;
  }

  dealTo(state, nextStreet);

  if (canStillBet < 2) {
    // Everyone is committed. Run the remaining board out, then show cards.
    runOut(state);
    return;
  }

  for (const seat of contenders(state)) seat.needsToAct = !seat.allIn;
  state.toAct = nextToAct(state, state.button);
  if (state.toAct === null) runOut(state);
}

/**
 * Deals whatever board is still owed and settles.
 *
 * Every path that ends a hand with two or more seats still in it comes through
 * here, so `settle` is never asked to score an incomplete board. Scoring five
 * cards as if they were seven silently picks the wrong winner.
 */
function runOut(state: HandState): void {
  if (contenders(state).length > 1) {
    while (state.street !== 'river') dealTo(state, followingStreet(state.street));
    dealTo(state, 'showdown');
  }
  settle(state);
}

function followingStreet(street: Street): Street {
  switch (street) {
    case 'preflop':
      return 'flop';
    case 'flop':
      return 'turn';
    case 'turn':
      return 'river';
    default:
      return 'showdown';
  }
}

function dealTo(state: HandState, street: Street): void {
  if (street === 'showdown') {
    state.street = 'showdown';
    return;
  }
  const count = street === 'flop' ? 3 : 1;
  const cards: Card[] = [];
  state.deck.pop(); // burn
  for (let i = 0; i < count; i++) cards.push(state.deck.pop()!);
  state.board.push(...cards);
  state.street = street;
  state.events.push({ type: 'street', street, cards });
}

/**
 * Builds side pots from what each seat put in, awards each layer, and closes the hand.
 * Layers are built from every contribution, folded seats included, because folded
 * money still belongs in the pot it was committed to.
 */
function settle(state: HandState): void {
  state.toAct = null;

  const levels = [...new Set(state.seats.filter((s) => s.contributed > 0).map((s) => s.contributed))].sort(
    (a, b) => a - b,
  );

  const pots: Pot[] = [];
  let previous = 0;
  let orphaned = 0; // chips from layers every contributor folded out of
  for (const level of levels) {
    const slice = level - previous;
    const payers = state.seats.filter((seat) => seat.contributed >= level);
    const eligible = payers.filter((seat) => !seat.folded).map((seat) => seat.index);
    const amount = slice * payers.length;
    previous = level;
    if (amount <= 0) continue;
    if (eligible.length === 0) {
      orphaned += amount;
      continue;
    }
    // Layers with the same contestants are one pot. Without this a hand that
    // folds around shows three "pots" that nobody was ever competing for.
    const previousPot = pots[pots.length - 1];
    if (previousPot && sameSeats(previousPot.eligible, eligible)) {
      previousPot.amount += amount + orphaned;
    } else {
      pots.push({ amount: amount + orphaned, eligible });
    }
    orphaned = 0;
  }
  if (orphaned > 0 && pots.length > 0) pots[pots.length - 1].amount += orphaned;
  state.pots = pots;

  const live = contenders(state);
  const uncontested = live.length === 1;

  if (!uncontested && state.street === 'showdown') {
    for (const seat of live) {
      state.events.push({
        type: 'showdown',
        seat: seat.index,
        hole: seat.hole!,
        score: evaluate([...seat.hole!, ...state.board]),
      });
    }
  }

  pots.forEach((pot, potIndex) => {
    const eligible = pot.eligible.filter((index) => !state.seats[index].folded);
    if (eligible.length === 0) return;

    let winners: number[];
    if (eligible.length === 1) {
      winners = eligible;
    } else {
      const scores = eligible.map((index) => evaluate([...state.seats[index].hole!, ...state.board]));
      const best = Math.max(...scores);
      winners = eligible.filter((_, i) => scores[i] === best);
    }

    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;

    // Odd chips go to the first winner clockwise from the button, as at a real table.
    const ordered = [...winners].sort((a, b) => seatOrderFromButton(state, a) - seatOrderFromButton(state, b));

    for (const index of ordered) {
      let award = share;
      if (remainder > 0) {
        award += 1;
        remainder -= 1;
      }
      state.seats[index].stack += award;
      state.events.push({ type: 'award', seat: index, amount: award, potIndex, uncontested });
    }
  });

  state.street = 'complete';
  state.events.push({
    type: 'hand-end',
    stacks: state.seats.map((seat) => ({ seat: seat.index, stack: seat.stack })),
  });
}

function sameSeats(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((seat, i) => seat === b[i]);
}

function seatOrderFromButton(state: HandState, index: number): number {
  const count = state.seats.length;
  return (index - state.button - 1 + count * 2) % count;
}
