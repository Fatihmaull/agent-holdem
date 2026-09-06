import type {
  ActionType,
  CardCode,
  DecisionSource,
  FeedEvent,
  HandRank,
  PlayerAction,
  PotView,
  Street,
} from '@agentholdem/shared';
import { commitToSeed, layoutDeal } from './cards.js';
import { evaluateHand } from './evaluator.js';

export interface HandSeatConfig {
  seat: number;
  agentName: string;
  owner: string;
  stack: number;
}

export interface HandPlayer {
  seat: number;
  agentName: string;
  owner: string;
  /** Chips still behind. */
  stack: number;
  /** Chips pushed forward on the current street. */
  committed: number;
  /** Chips pushed forward across the whole hand. */
  invested: number;
  folded: boolean;
  allIn: boolean;
  holeCards: CardCode[];
  /** Has acted since the last full raise on this street. */
  hasActed: boolean;
  /**
   * True when the player is facing an incomplete all-in raise. Poker does not
   * reopen the betting for someone who has already acted when the raise was
   * short, so they may call or fold but not re-raise.
   */
  raiseLocked: boolean;
  lastAction: PlayerAction | null;
}

export interface LegalActions {
  seat: number;
  /** Chips needed to match the current bet. Capped by the stack. */
  toCall: number;
  canCheck: boolean;
  canCall: boolean;
  canRaise: boolean;
  /** Smallest legal total commitment for a raise this street. */
  minRaiseTo: number;
  /** Largest legal total commitment (a shove). */
  maxRaiseTo: number;
  potIfCalled: number;
}

export interface HandOptions {
  seats: HandSeatConfig[];
  /** Index into `seats` holding the button. */
  buttonIndex: number;
  smallBlind: number;
  bigBlind: number;
  seed: string;
  handNumber: number;
  now?: () => number;
}

export interface SeatResult {
  seat: number;
  agentName: string;
  owner: string;
  invested: number;
  won: number;
  net: number;
  stackAfter: number;
  folded: boolean;
  showdownRank: HandRank | null;
}

export interface HandResult {
  handNumber: number;
  seed: string;
  commitment: string;
  board: CardCode[];
  pots: PotView[];
  seats: SeatResult[];
  wentToShowdown: boolean;
}

const STREET_ORDER: readonly Street[] = ['preflop', 'flop', 'turn', 'river', 'showdown'];

/**
 * One hand of no-limit Texas Hold'em, driven a single decision at a time.
 *
 * The engine is deliberately synchronous and side-effect free: the table
 * runner asks for `currentActor()`, gets a decision from an LLM (or the
 * timeout fallback), calls `applyAction()`, and drains `takeEvents()`. That
 * split is what lets a table keep running with nobody watching it — nothing
 * in here depends on a socket being connected.
 */
export class HandEngine {
  readonly players: HandPlayer[];
  readonly buttonIndex: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly seed: string;
  readonly commitment: string;
  readonly handNumber: number;

  street: Street = 'preflop';
  board: CardCode[] = [];
  currentBet = 0;
  /** Size of the last full raise; the next legal raise is `currentBet + this`. */
  minRaiseIncrement: number;
  actingIndex: number | null = null;
  complete = false;

  private readonly layout: ReturnType<typeof layoutDeal>;
  private readonly now: () => number;
  private events: FeedEvent[] = [];
  private finalResult: HandResult | null = null;

  constructor(opts: HandOptions) {
    if (opts.seats.length < 2) throw new Error('A hand needs at least two seats');
    if (opts.seats.some((s) => s.stack <= 0)) {
      throw new Error('Every seated agent must have chips before the hand starts');
    }
    this.now = opts.now ?? (() => Date.now());
    this.handNumber = opts.handNumber;
    this.smallBlind = opts.smallBlind;
    this.bigBlind = opts.bigBlind;
    this.minRaiseIncrement = opts.bigBlind;
    this.seed = opts.seed;
    this.commitment = commitToSeed(opts.seed);
    this.buttonIndex = opts.buttonIndex % opts.seats.length;
    this.layout = layoutDeal(opts.seed, opts.seats.length);

    this.players = opts.seats.map((s, i) => ({
      seat: s.seat,
      agentName: s.agentName,
      owner: s.owner,
      stack: s.stack,
      committed: 0,
      invested: 0,
      folded: false,
      allIn: false,
      holeCards: [...(this.layout.holeCards[i] ?? [])],
      hasActed: false,
      raiseLocked: false,
      lastAction: null,
    }));

    this.emit({
      kind: 'hand-start',
      handNumber: this.handNumber,
      button: this.players[this.buttonIndex]?.seat ?? 0,
      commitment: this.commitment,
      at: this.now(),
    });

    this.postBlinds();
  }

  /* ---------------------------------------------------------------- *
   * Event plumbing
   * ---------------------------------------------------------------- */

  private emit(event: FeedEvent): void {
    this.events.push(event);
  }

  /** Drains the event queue. The runner broadcasts whatever it gets. */
  takeEvents(): FeedEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /* ---------------------------------------------------------------- *
   * Setup
   * ---------------------------------------------------------------- */

  private seatOffset(offset: number): number {
    return (this.buttonIndex + offset) % this.players.length;
  }

  private postBlinds(): void {
    const heads = this.players.length === 2;
    const sbIndex = heads ? this.buttonIndex : this.seatOffset(1);
    const bbIndex = heads ? this.seatOffset(1) : this.seatOffset(2);

    const sbPosted = this.forcePost(sbIndex, this.smallBlind);
    const bbPosted = this.forcePost(bbIndex, this.bigBlind);

    this.currentBet = Math.max(sbPosted, bbPosted, 0);
    this.minRaiseIncrement = this.bigBlind;

    this.emit({
      kind: 'blinds',
      postings: [
        { seat: this.players[sbIndex]?.seat ?? 0, amount: sbPosted, label: 'sb' },
        { seat: this.players[bbIndex]?.seat ?? 0, amount: bbPosted, label: 'bb' },
      ],
      at: this.now(),
    });

    this.emit({
      kind: 'deal',
      street: 'preflop',
      board: [],
      at: this.now(),
    });

    // Heads-up: the button is the small blind and acts first pre-flop.
    // Three-handed and up: action starts under the gun, left of the big blind.
    const firstToAct = heads ? this.buttonIndex : this.seatOffset(3);
    this.actingIndex = this.nextActionable(firstToAct, true);
    if (this.actingIndex === null) this.closeStreet();
  }

  /** Posts a blind, clamping to the stack so a short stack posts all-in. */
  private forcePost(index: number, amount: number): number {
    const p = this.players[index];
    if (!p) return 0;
    const posted = Math.min(amount, p.stack);
    p.stack -= posted;
    p.committed += posted;
    p.invested += posted;
    if (p.stack === 0) p.allIn = true;
    return posted;
  }

  /* ---------------------------------------------------------------- *
   * Turn selection
   * ---------------------------------------------------------------- */

  private canAct(p: HandPlayer): boolean {
    return !p.folded && !p.allIn && p.stack > 0;
  }

  /** First index at or after `from` that still has a decision to make. */
  private nextActionable(from: number, inclusive = false): number | null {
    const n = this.players.length;
    for (let step = inclusive ? 0 : 1; step <= n; step++) {
      const idx = (from + step) % n;
      const p = this.players[idx];
      if (!p || !this.canAct(p)) continue;
      if (!p.hasActed || p.committed < this.currentBet) return idx;
    }
    return null;
  }

  private livePlayers(): HandPlayer[] {
    return this.players.filter((p) => !p.folded);
  }

  /** Everyone who could still put more chips in. */
  private actionablePlayers(): HandPlayer[] {
    return this.players.filter((p) => this.canAct(p));
  }

  /* ---------------------------------------------------------------- *
   * Public query surface
   * ---------------------------------------------------------------- */

  get totalPot(): number {
    return this.players.reduce((sum, p) => sum + p.invested, 0);
  }

  currentActor(): { index: number; player: HandPlayer; legal: LegalActions } | null {
    if (this.complete || this.actingIndex === null) return null;
    const player = this.players[this.actingIndex];
    if (!player) return null;
    return { index: this.actingIndex, player, legal: this.legalActions(this.actingIndex) };
  }

  legalActions(index: number): LegalActions {
    const p = this.players[index];
    if (!p) throw new Error(`No player at index ${index}`);
    const toCall = Math.min(this.currentBet - p.committed, p.stack);
    const maxRaiseTo = p.committed + p.stack;
    const wantMinRaiseTo = this.currentBet + this.minRaiseIncrement;
    // A stack too short for a full raise can still shove; that shove is a
    // legal (incomplete) raise, it just does not reopen the betting.
    const minRaiseTo = Math.min(wantMinRaiseTo, maxRaiseTo);
    const canRaise = !p.raiseLocked && maxRaiseTo > this.currentBet;
    return {
      seat: p.seat,
      toCall,
      canCheck: this.currentBet - p.committed <= 0,
      canCall: toCall > 0,
      canRaise,
      minRaiseTo,
      maxRaiseTo,
      potIfCalled: this.totalPot + toCall,
    };
  }

  /* ---------------------------------------------------------------- *
   * Applying a decision
   * ---------------------------------------------------------------- */

  /**
   * Applies one decision for the acting seat and advances the hand.
   *
   * `requested` is trusted only for its *shape*: every amount is re-derived
   * from the engine's own legality rules, so a hallucinated raise size can
   * never move more chips than the player actually has.
   */
  applyAction(
    requested: PlayerAction,
    meta: { source?: DecisionSource; latencyMs?: number } = {},
  ): PlayerAction {
    const actor = this.currentActor();
    if (!actor) throw new Error('No player is currently to act');
    const { index, player, legal } = actor;

    const applied = this.legalize(requested, legal);

    switch (applied.type) {
      case 'fold':
        player.folded = true;
        break;
      case 'check':
        break;
      case 'call':
      case 'raise':
      case 'all-in': {
        const target = applied.amount; // total committed this street
        const delta = target - player.committed;
        player.stack -= delta;
        player.committed = target;
        player.invested += delta;
        if (player.stack === 0) player.allIn = true;

        if (target > this.currentBet) {
          const raiseSize = target - this.currentBet;
          const fullRaise = raiseSize >= this.minRaiseIncrement;
          this.currentBet = target;
          if (fullRaise) {
            this.minRaiseIncrement = raiseSize;
            for (const other of this.players) {
              if (other === player || other.folded || other.allIn) continue;
              other.hasActed = false;
              other.raiseLocked = false;
            }
          } else {
            // Incomplete all-in: players who already acted may only call or fold.
            for (const other of this.players) {
              if (other === player || other.folded || other.allIn) continue;
              if (other.hasActed) other.raiseLocked = true;
            }
          }
        }
        break;
      }
    }

    player.hasActed = true;
    player.lastAction = applied;

    this.emit({
      kind: 'action',
      seat: player.seat,
      agentName: player.agentName,
      action: applied,
      street: this.street,
      potAfter: this.totalPot,
      source: meta.source ?? 'llm',
      latencyMs: meta.latencyMs ?? 0,
      at: this.now(),
    });

    this.advance(index);
    return applied;
  }

  /**
   * Maps a requested action onto the closest legal one.
   *
   * Models routinely ask to raise 3bb when they have 2bb behind, or to check
   * facing a bet. Rather than punishing the table with an exception we clamp
   * to the nearest legal action, which is exactly what a live dealer does.
   */
  legalize(requested: PlayerAction, legal: LegalActions): PlayerAction {
    const type: ActionType = requested.type;

    if (type === 'fold') {
      // Folding when checking is free is strictly dominated; every online
      // room treats the click as a check, and so do we.
      return legal.canCheck ? { type: 'check', amount: 0 } : { type: 'fold', amount: 0 };
    }

    if (type === 'check') {
      if (legal.canCheck) return { type: 'check', amount: 0 };
      // Facing a bet, "check" is not available. Fall back to fold, which is
      // the conservative reading of an agent that did not want to invest.
      return { type: 'fold', amount: 0 };
    }

    if (type === 'call') {
      if (!legal.canCall) return { type: 'check', amount: 0 };
      const target = this.playerAt(legal.seat).committed + legal.toCall;
      const allIn = legal.toCall >= this.playerAt(legal.seat).stack;
      return { type: allIn ? 'all-in' : 'call', amount: target };
    }

    if (type === 'all-in') {
      if (legal.maxRaiseTo <= this.playerAt(legal.seat).committed) {
        return legal.canCheck ? { type: 'check', amount: 0 } : { type: 'fold', amount: 0 };
      }
      return { type: 'all-in', amount: legal.maxRaiseTo };
    }

    // raise
    if (!legal.canRaise) {
      if (legal.canCall) {
        const target = this.playerAt(legal.seat).committed + legal.toCall;
        const allIn = legal.toCall >= this.playerAt(legal.seat).stack;
        return { type: allIn ? 'all-in' : 'call', amount: target };
      }
      return legal.canCheck ? { type: 'check', amount: 0 } : { type: 'fold', amount: 0 };
    }
    const clamped = Math.max(legal.minRaiseTo, Math.min(requested.amount, legal.maxRaiseTo));
    const rounded = Math.floor(clamped);
    const target = Math.max(legal.minRaiseTo, Math.min(rounded, legal.maxRaiseTo));
    return { type: target >= legal.maxRaiseTo ? 'all-in' : 'raise', amount: target };
  }

  private playerAt(seat: number): HandPlayer {
    const p = this.players.find((x) => x.seat === seat);
    if (!p) throw new Error(`No player in seat ${seat}`);
    return p;
  }

  /* ---------------------------------------------------------------- *
   * Street / hand progression
   * ---------------------------------------------------------------- */

  private advance(fromIndex: number): void {
    if (this.livePlayers().length === 1) {
      this.finish(false);
      return;
    }
    const next = this.nextActionable(fromIndex);
    if (next !== null) {
      this.actingIndex = next;
      return;
    }
    this.closeStreet();
  }

  private closeStreet(): void {
    for (const p of this.players) {
      p.committed = 0;
      p.hasActed = false;
      p.raiseLocked = false;
    }
    this.currentBet = 0;
    this.minRaiseIncrement = this.bigBlind;

    if (this.livePlayers().length === 1) {
      this.finish(false);
      return;
    }

    // With at most one player able to act, no betting is left: run the board.
    const noMoreBetting = this.actionablePlayers().length <= 1;

    let idx = STREET_ORDER.indexOf(this.street);
    while (idx < STREET_ORDER.length - 1) {
      idx += 1;
      const next = STREET_ORDER[idx] as Street;
      this.street = next;
      this.dealStreet(next);
      if (next === 'showdown') break;
      if (!noMoreBetting) {
        // Post-flop the action always starts left of the button, which is
        // the small blind multi-way and the big blind heads-up.
        const actor = this.nextActionable(this.seatOffset(1), true);
        if (actor !== null) {
          this.actingIndex = actor;
          return;
        }
      }
    }

    this.street = 'showdown';
    this.finish(true);
  }

  private dealStreet(street: Street): void {
    if (street === 'flop') this.board = [...this.layout.flop];
    else if (street === 'turn') this.board = [...this.layout.flop, this.layout.turn];
    else if (street === 'river') {
      this.board = [...this.layout.flop, this.layout.turn, this.layout.river];
    } else return;

    this.emit({ kind: 'deal', street, board: [...this.board], at: this.now() });
  }

  /* ---------------------------------------------------------------- *
   * Pots and payouts
   * ---------------------------------------------------------------- */

  /**
   * Splits total contributions into a main pot plus side pots.
   *
   * Chips from folded players stay in the pots they helped build; they just
   * are not eligible to win them. Pots at the same eligibility level are
   * merged so the UI shows "main + one side pot", not four fragments.
   */
  buildPots(): PotView[] {
    const levels = [...new Set(this.players.map((p) => p.invested))]
      .filter((v) => v > 0)
      .sort((a, b) => a - b);

    const pots: PotView[] = [];
    let previous = 0;
    for (const level of levels) {
      let amount = 0;
      for (const p of this.players) {
        amount += Math.min(p.invested, level) - Math.min(p.invested, previous);
      }
      const eligible = this.players
        .filter((p) => !p.folded && p.invested >= level)
        .map((p) => p.seat);
      if (amount > 0 && eligible.length > 0) {
        const last = pots[pots.length - 1];
        if (last && last.eligible.length === eligible.length &&
            last.eligible.every((s, i) => s === eligible[i])) {
          pots[pots.length - 1] = { amount: last.amount + amount, eligible: last.eligible };
        } else {
          pots.push({ amount, eligible });
        }
      } else if (amount > 0 && pots.length > 0) {
        // Every eligible player folded: fold the orphaned chips into the
        // previous pot rather than letting them vanish.
        const last = pots[pots.length - 1] as PotView;
        pots[pots.length - 1] = { amount: last.amount + amount, eligible: last.eligible };
      }
      previous = level;
    }
    return pots;
  }

  private finish(showdown: boolean): void {
    if (this.complete) return;
    this.complete = true;
    this.actingIndex = null;

    const pots = this.buildPots();
    const ranks = new Map<number, HandRank>();

    if (showdown && this.board.length === 5) {
      for (const p of this.livePlayers()) {
        ranks.set(p.seat, evaluateHand([...p.holeCards, ...this.board]));
      }
    }

    const wentToShowdown = showdown && this.livePlayers().length > 1;
    if (wentToShowdown) {
      this.emit({
        kind: 'showdown',
        reveals: this.livePlayers().map((p) => ({
          seat: p.seat,
          cards: [...p.holeCards],
          rank: ranks.get(p.seat) ?? null,
        })),
        at: this.now(),
      });
    }

    const won = new Map<number, number>();
    const awards: { seat: number; agentName: string; amount: number; potIndex: number }[] = [];

    pots.forEach((pot, potIndex) => {
      const contenders = pot.eligible
        .map((seat) => this.players.find((p) => p.seat === seat))
        .filter((p): p is HandPlayer => Boolean(p) && !(p as HandPlayer).folded);

      if (contenders.length === 0) return;

      let winners: HandPlayer[];
      if (contenders.length === 1 || !wentToShowdown) {
        winners = [contenders[0] as HandPlayer];
      } else {
        let best = -1;
        winners = [];
        for (const c of contenders) {
          const score = ranks.get(c.seat)?.score ?? -1;
          if (score > best) {
            best = score;
            winners = [c];
          } else if (score === best) {
            winners.push(c);
          }
        }
      }

      // Split pots pay whole chips; the odd chip goes to the first winner
      // left of the button, matching standard house rules.
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      const ordered = this.orderFromButton(winners);
      for (const w of ordered) {
        const extra = remainder > 0 ? 1 : 0;
        remainder -= extra;
        const amount = share + extra;
        if (amount <= 0) continue;
        w.stack += amount;
        won.set(w.seat, (won.get(w.seat) ?? 0) + amount);
        awards.push({ seat: w.seat, agentName: w.agentName, amount, potIndex });
      }
    });

    this.emit({ kind: 'payout', awards, seed: this.seed, at: this.now() });

    this.finalResult = {
      handNumber: this.handNumber,
      seed: this.seed,
      commitment: this.commitment,
      board: [...this.board],
      pots,
      wentToShowdown,
      seats: this.players.map((p) => ({
        seat: p.seat,
        agentName: p.agentName,
        owner: p.owner,
        invested: p.invested,
        won: won.get(p.seat) ?? 0,
        net: (won.get(p.seat) ?? 0) - p.invested,
        stackAfter: p.stack,
        folded: p.folded,
        showdownRank: ranks.get(p.seat) ?? null,
      })),
    };
  }

  /** Winners in seat order starting left of the button. */
  private orderFromButton(players: HandPlayer[]): HandPlayer[] {
    const n = this.players.length;
    return [...players].sort((a, b) => {
      const ai = (this.players.indexOf(a) - this.buttonIndex + n) % n;
      const bi = (this.players.indexOf(b) - this.buttonIndex + n) % n;
      return ai - bi;
    });
  }

  result(): HandResult {
    if (!this.finalResult) throw new Error('Hand is still in progress');
    return this.finalResult;
  }
}
