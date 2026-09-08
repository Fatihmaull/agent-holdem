import { cardName, type Card } from '../poker/cards';
import { applyAction, legalActions, startHand, totalPot, type HandState, type Street } from '../poker/engine';
import { describe as describeHand, evaluate } from '../poker/evaluate';
import { decide, type DecisionRecord } from '../agent/decide';
import { OPPONENT_COLORS } from '../agent/colors';
import type { ModelProvider } from '../agent/provider';
import type { ModelQueue } from '../agent/queue';
import { type TableConfig, tableLabel } from '../lib/economy';
import {
  ACTION_BEAT_MS,
  ACT_CLOCK_MS,
  AWARD_BEAT_MS,
  BETWEEN_HANDS_MS,
  HAND_END_BEAT_MS,
  REVEAL_BEAT_MS,
  SHOWDOWN_BEAT_MS,
  STREET_BEAT_MS,
  STREET_SETTLE_MS,
  pacingFloor,
} from '../lib/pacing';
import { TableBus } from './bus';
import {
  lastHandNumber,
  leaveSeat,
  loadSeats,
  recordResults,
  saveHand,
  saveStacks,
  type SeatedAgent,
} from './store';
import { logger } from './log';
import type { ArenaEvent, BrainView, LogLine, SeatStatus, SeatView, TableView } from './view';

export class TableRuntime {
  readonly bus = new TableBus();

  private seated: SeatedAgent[] = [];
  private state: HandState | null = null;
  /**
   * The seats in this hand, in engine order. The engine numbers seats densely
   * from zero; the table numbers them by chair, and chairs go sparse as soon as
   * anyone in the middle stands up. This array is the only bridge between the
   * two, so nothing outside it may assume the numbers agree.
   */
  private lineup: SeatedAgent[] = [];
  /** Colour to draw each chair in, after resolving collisions at this table. */
  private palette = new Map<number, string>();
  private handNumber = 0;
  /** The button follows a chair, not a position, so it survives a seat change. */
  private buttonChair = -1;
  /** True from the moment a hand's lineup is fixed until its result is stored. */
  private handLive = false;
  /** Cash-outs that are mid-flight, which must not race a hand starting. */
  private leaving = 0;
  /** Agents that asked to leave while their hand was still running. */
  private pendingLeave = new Set<string>();
  private toAct: number | null = null;
  private deadline: number | null = null;
  private brain: BrainView | null = null;
  private shown = new Map<number, Card[]>();
  private timing = new Map<number, { elapsedMs: number; action: string; amount: number; to: number }>();
  /** What each chair won this hand, so a snapshot mid-award still shows it. */
  private won = new Map<number, number>();
  /** Blinds posted this hand. Posting one is not acting, so it is kept apart. */
  private blinds = new Map<number, { kind: 'small' | 'big'; amount: number }>();
  private talk = new Map<number, string>();
  private log: LogLine[] = [];
  private logSequence = 0;
  private handEndedAt: number | null = null;
  /** True while the loop is dealing new hands. Cleared by a drain. */
  private dealing = false;
  /** True while the loop function is alive, which outlives `dealing` by one hand. */
  private looping = false;
  /** Aborts whatever is in flight. A drain deliberately does not touch this. */
  private stopping = new AbortController();
  /** Resolves when the loop has actually exited, so a shutdown can wait on it. */
  private exited: Promise<void> = Promise.resolve();
  /** Server-side log. The `log` above is the ticker spectators read. */
  private readonly journal = logger.child({ table: this.config.id });

  constructor(
    readonly config: TableConfig,
    private readonly provider: ModelProvider,
    private readonly queue: ModelQueue,
    /**
     * Multiplies every beat. Exactly one caller passes anything but 1: the
     * shutdown tests, which need a hand to start and finish inside a test
     * rather than at the pace a spectator reads it. Nothing in production
     * touches it, so the pacing a player sees is still the one in `pacing.ts`.
     */
    private readonly paceScale = 1,
  ) {}

  async refreshSeats(): Promise<void> {
    this.seated = await loadSeats(this.config.id);
    this.palette = tablePalette(this.seated);
    this.publish({ type: 'seats', seats: this.seatViews(null) });
  }

  /** Engine position for a chair, or null when that chair is not in this hand. */
  private positionOf(chair: number): number | null {
    const position = this.lineup.findIndex((seat) => seat.seatIndex === chair);
    return position < 0 ? null : position;
  }

  /** Chair a given engine position is sitting in. */
  private chairOf(position: number): number {
    return this.lineup[position]?.seatIndex ?? position;
  }

  /**
   * Takes an agent out of its seat and returns its stack.
   *
   * A hand already in progress owns the chips in front of it, so a request that
   * arrives mid-hand is held until the hand is stored rather than paying out a
   * stack the table is still playing with. `leaving` is raised before the first
   * await so the match loop cannot start a hand around a seat that is going.
   */
  async requestLeave(agentId: string, seatIndex: number): Promise<'left' | 'queued'> {
    if (this.handLive && this.lineup.some((seat) => seat.agentId === agentId)) {
      this.pendingLeave.add(agentId);
      return 'queued';
    }

    this.leaving += 1;
    try {
      await leaveSeat(this.config.id, seatIndex);
      await this.refreshSeats();
    } finally {
      this.leaving -= 1;
    }
    return 'left';
  }

  /** Whether this agent is sitting in the hand being played right now. */
  isInLiveHand(agentId: string): boolean {
    return this.handLive && this.lineup.some((seat) => seat.agentId === agentId);
  }

  start(): void {
    if (this.looping) return;
    this.dealing = true;
    this.looping = true;
    this.stopping = new AbortController();
    this.exited = this.loop();
  }

  /**
   * Stops dealing new hands and lets the one in progress finish.
   *
   * This is what a deploy should do. Aborting instead throws away a hand that
   * players are in the middle of: the chips are safe either way, because an
   * incomplete hand is never stored, but every bet in it is undone and the
   * table visibly jumps backwards.
   */
  drain(): void {
    this.dealing = false;
  }

  /** Gives up on the hand in progress. Nothing incomplete is ever stored. */
  stop(): void {
    this.dealing = false;
    this.stopping.abort();
  }

  /** Resolves once the loop has exited, whether it was drained or aborted. */
  async finished(): Promise<void> {
    await this.exited;
  }

  /** Whether this table is still dealing. The health check asks. */
  get live(): boolean {
    return this.dealing;
  }

  /** When this table last finished a hand, so a stalled engine is visible. */
  get lastHandAt(): number | null {
    return this.handEndedAt;
  }

  /**
   * The table as one viewer is entitled to see it. Hole cards belong to their
   * owner until a real showdown, so the redaction happens here rather than in
   * the browser where it would only be a suggestion.
   */
  view(viewerAgentId: string | null): TableView {
    return {
      tableId: this.config.id,
      label: tableLabel(this.config),
      format: this.config.format,
      seatCount: this.config.seats,
      smallBlind: this.config.smallBlind,
      bigBlind: this.config.bigBlind,
      buyIn: this.config.buyIn,
      handNumber: this.handNumber,
      street: this.state ? this.state.street : 'idle',
      board: (this.state?.board ?? []).map(cardName),
      pot: this.state ? totalPot(this.state) : 0,
      seats: this.seatViews(viewerAgentId),
      toAct: this.toAct,
      deadline: this.deadline,
      remainingMs: this.deadline === null ? null : Math.max(0, this.deadline - Date.now()),
      brain: this.brain,
      log: this.log.slice(-40),
    };
  }

  private seatViews(viewerAgentId: string | null): SeatView[] {
    return Array.from({ length: this.config.seats }, (_, index) => {
      const occupant = this.seated.find((seat) => seat.seatIndex === index);
      const position = this.positionOf(index);
      const live = position === null ? undefined : this.state?.seats[position];
      const timing = this.timing.get(index);

      if (!occupant) {
        return {
          index,
          agentId: null,
          name: null,
          color: null,
          stack: 0,
          committed: 0,
          status: 'empty' as SeatStatus,
          isDealer: false,
          hole: null,
          lastActionMs: null,
          lastAction: null,
          lastActionAmount: null,
          lastActionTo: null,
          won: null,
          blind: null,
          say: null,
        };
      }

      const revealed = this.shown.get(index);
      const ownCards = viewerAgentId !== null && viewerAgentId === occupant.agentId;
      const hole = revealed ?? (ownCards && live?.hole ? [...live.hole] : null);

      return {
        index,
        agentId: occupant.agentId,
        name: occupant.name,
        color: this.palette.get(index) ?? occupant.color,
        stack: live?.stack ?? occupant.stack,
        committed: live?.committed ?? 0,
        status: this.statusOf(index, live),
        isDealer: this.state !== null && position !== null && position === this.state.button,
        hole: hole ? hole.map(cardName) : null,
        lastActionMs: timing?.elapsedMs ?? null,
        lastAction: timing?.action ?? null,
        lastActionAmount: timing?.amount ?? null,
        lastActionTo: timing?.to ?? null,
        won: this.won.get(index) ?? null,
        // A blind is only a blind before the flop. After that the chips are in
        // the pot and being made to post one says nothing about this street.
        blind: this.state?.street === 'preflop' ? (this.blinds.get(index) ?? null) : null,
        say: this.talk.get(index) ?? null,
      };
    });
  }

  private statusOf(index: number, live: HandState['seats'][number] | undefined): SeatStatus {
    if (!live) return 'waiting';
    if (live.folded) return 'folded';
    if (live.allIn) return 'all-in';
    if (this.toAct === index) return 'thinking';
    return live.hasActed ? 'acted' : 'waiting';
  }

  private publish(event: ArenaEvent): void {
    this.bus.publish(event);
  }

  private note(text: string, seat: number | null = null): void {
    const line: LogLine = { id: ++this.logSequence, at: Date.now(), text, seat };
    this.log.push(line);
    if (this.log.length > 200) this.log.shift();
    this.publish({ type: 'log', line });
  }

  private async pause(milliseconds: number): Promise<void> {
    const ms = milliseconds * this.paceScale;
    if (ms <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.stopping.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  private async loop(): Promise<void> {
    try {
      while (this.dealing) {
        await this.deal();
      }
    } finally {
      this.looping = false;
      this.journal.info('table.stopped', { handNumber: this.handNumber });
    }
  }

  /** One turn of the loop: get ready, play a hand if we can, wait. */
  private async deal(): Promise<void> {
    {
      // Pick up where this table left off, so numbering never collides with
      // what is already stored. Guessing zero here makes every later save
      // violate the unique hand number and the table deals into a void, so a
      // failed read waits and asks again instead.
      if (this.handNumber === 0) {
        try {
          this.handNumber = await lastHandNumber(this.config.id);
        } catch (error) {
          this.journal.error('table.hand-number-unreadable', { error: describeError(error) });
          this.publish({ type: 'idle', reason: 'Reconnecting to the match record.' });
          await this.pause(4_000);
          return;
        }
      }

      // A table whose seats cannot be read has nothing to deal to. Letting this
      // throw would end the loop for the life of the process, so a database
      // blip would silently retire the table instead of pausing it.
      try {
        await this.refreshSeats();
      } catch (error) {
        this.journal.error('table.seats-unreadable', { error: describeError(error) });
        this.publish({ type: 'idle', reason: 'Reconnecting to the match record.' });
        await this.pause(4_000);
        return;
      }

      // A cash-out is mid-flight. Its seat still shows a stack that the payout
      // is about to claim, so no hand may be built around it.
      if (this.leaving > 0) {
        await this.pause(200);
        return;
      }

      if (this.seated.length < 2) {
        this.state = null;
        this.toAct = null;
        this.deadline = null;
        this.publish({ type: 'idle', reason: 'Waiting for a second agent to sit down.' });
        await this.pause(4_000);
        return;
      }

      try {
        await this.playHand();
      } catch (error) {
        // Spectators get a plain sentence; the detail goes to the server log,
        // because a driver's error text is not something to put on the ticker.
        this.journal.error('table.hand-abandoned', { handNumber: this.handNumber, error: describeError(error) });
        this.note('That hand could not be completed and was abandoned.');
      } finally {
        // Whatever happened, no hand is holding chips any more. Leaving this
        // set would block every cash-out at this table until the next deal.
        this.handLive = false;
        this.handEndedAt = Date.now();
      }

      await this.pause(BETWEEN_HANDS_MS);
    }
  }

  private async playHand(): Promise<void> {
    // Fixing the lineup is what makes the hand live. Nothing between here and
    // the first await may yield, or a cash-out could slip in beside it.
    const lineup = [...this.seated].sort((a, b) => a.seatIndex - b.seatIndex);
    this.lineup = lineup;
    this.handLive = true;

    const seed = (Math.random() * 2 ** 31) | 0;
    const startedAt = new Date();

    this.handNumber += 1;
    // The button moves to the next occupied chair, so a seat changing hands
    // between deals cannot hand the same player the button twice or skip a
    // player's blinds.
    const button = nextButtonPosition(lineup, this.buttonChair);
    this.buttonChair = lineup[button].seatIndex;
    this.shown.clear();
    this.timing.clear();
    this.talk.clear();
    this.won.clear();
    this.blinds.clear();
    this.brain = null;

    let state = startHand({
      handId: `${this.config.id}-${this.handNumber}`,
      seats: lineup.map((seat) => ({ agentId: seat.agentId, stack: seat.stack })),
      button,
      smallBlind: this.config.smallBlind,
      bigBlind: this.config.bigBlind,
      seed,
    });
    this.state = state;

    // Who was made to post what, so a seat that has not acted yet still has
    // something true to show rather than an empty line.
    for (const event of state.events) {
      if (event.type === 'blind') this.blinds.set(this.chairOf(event.seat), { kind: event.kind, amount: event.amount });
    }

    this.note(`Hand ${this.handNumber} dealt. Blinds ${this.config.smallBlind}/${this.config.bigBlind}.`);
    this.publish({
      type: 'hand-start',
      handNumber: this.handNumber,
      button: this.buttonChair,
      seats: this.seatViews(null),
    });

    const recorded: Array<{ seatIndex: number; agentId: string; record: DecisionRecord; street: string }> = [];
    let eventCursor = state.events.length;
    let street: Street = state.street;

    while (state.toAct !== null && !this.stopping.signal.aborted) {
      const position = state.toAct;
      const chair = this.chairOf(position);
      const agent = lineup[position];
      if (!agent) throw new Error(`seat ${position} has no agent`);
      const color = this.palette.get(chair) ?? agent.color;

      const legal = legalActions(state)!;
      const potOdds = legal.toCall > 0 ? legal.toCall / (legal.potSize + legal.toCall) : null;

      this.toAct = chair;
      this.deadline = Date.now() + ACT_CLOCK_MS;
      this.brain = {
        seat: chair,
        seatName: agent.name,
        color,
        street: state.street,
        reasoning: '',
        equity: null,
        handRead: null,
        potOdds,
        action: null,
        amount: null,
        outcome: null,
        failure: null,
        elapsedMs: null,
      };
      this.publish({
        type: 'to-act',
        seat: chair,
        seatName: agent.name,
        color,
        deadline: this.deadline,
        // The browser's clock is not this one. Sending what is left lets the
        // arena count down against its own clock instead of a foreign epoch.
        remainingMs: ACT_CLOCK_MS,
        potOdds,
        street: state.street,
      });

      const record = await decide({
        agent: { id: agent.agentId, name: agent.name, instructions: agent.instructions },
        state,
        seatIndex: position,
        bigBlind: this.config.bigBlind,
        clockMs: ACT_CLOCK_MS,
        opponentNames: new Map(lineup.map((seat) => [seat.agentId, seat.name])),
        provider: this.provider,
        queue: this.queue,
        signal: this.stopping.signal,
        onEquity: (equity, read) => {
          if (this.brain?.seat === chair) {
            this.brain.equity = equity.equity;
            this.brain.handRead = read;
          }
          this.publish({ type: 'equity', seat: chair, equity: equity.equity, handRead: read });
        },
        onToken: (delta) => {
          if (this.brain?.seat === chair) this.brain.reasoning += delta;
          this.publish({ type: 'reasoning', seat: chair, delta });
        },
      });

      // A shutdown is not a decision. Aborting mid-request makes `decide` fall
      // back to check-or-fold, which is right when a seat runs out its own
      // clock and wrong when we ran out of ours: folding a player's hand
      // because we are deploying costs them the pot. So the fallback is
      // discarded and the hand is abandoned, which costs a hand and no chips.
      if (this.stopping.signal.aborted) {
        this.handLive = false;
        this.note('The table stopped mid-hand. That hand does not count.');
        return;
      }

      // Hesitation is information, so a close decision is held on screen longer
      // than a routine one. The model's own latency counts toward the floor.
      await this.pause(pacingFloor(record.equity.equity, potOdds) - record.elapsedMs);

      state = applyAction(state, record.action);
      this.state = state;

      const seatState = state.seats[position];
      const applied = lastActionEvent(state, eventCursor);
      this.timing.set(chair, {
        elapsedMs: record.elapsedMs,
        action: applied?.action ?? record.action.type,
        amount: applied?.amount ?? 0,
        to: applied?.to ?? 0,
      });
      if (record.say) this.talk.set(chair, record.say);

      this.brain = {
        seat: chair,
        seatName: agent.name,
        color,
        street,
        reasoning: record.reasoning,
        equity: record.equity.equity,
        handRead: record.read,
        potOdds,
        action: applied?.action ?? record.action.type,
        amount: applied?.amount ?? 0,
        outcome: record.outcome,
        failure: record.failure,
        elapsedMs: record.elapsedMs,
      };

      this.publish({
        type: 'decision',
        seat: chair,
        action: applied?.action ?? record.action.type,
        amount: applied?.amount ?? 0,
        to: applied?.to ?? 0,
        equity: record.equity.equity,
        handRead: record.read,
        outcome: record.outcome,
        failure: record.failure,
        elapsedMs: record.elapsedMs,
        say: record.say,
        reasoning: record.reasoning,
        stack: seatState.stack,
        committed: seatState.committed,
        pot: totalPot(state),
      });

      this.note(describeAction(agent.name, applied?.action ?? record.action.type, applied?.amount ?? 0), chair);
      // Stored hands are indexed by engine position, which is what the lineup
      // written alongside them is indexed by.
      recorded.push({ seatIndex: position, agentId: agent.agentId, record, street });

      // The decision has to be the only new thing on screen for long enough to
      // read who acted and for how much, or the next seat's clock starts on top
      // of it and the hand becomes a blur of totals that were never shown.
      await this.pause(ACTION_BEAT_MS);

      eventCursor = await this.flushBoardEvents(state, eventCursor);
      street = state.street === 'complete' ? street : state.street;
      this.toAct = state.toAct === null ? null : this.chairOf(state.toAct);
      this.deadline = null;
    }

    await this.flushBoardEvents(state, eventCursor);
    this.toAct = null;
    this.deadline = null;

    // Shutting down mid-hand leaves chips in the pot that belong to no seat.
    // Storing the stacks now would delete them, so the hand is abandoned and
    // the stored stacks, which still hold every chip, stand as they are.
    if (state.toAct !== null) {
      this.handLive = false;
      this.note('The table stopped mid-hand. That hand does not count.');
      return;
    }

    await this.settleOnScreen(state, lineup);
    await this.persist({ lineup, state, seed, startedAt, recorded });
  }

  /** Streets and showdowns land as their own beats rather than inside a decision. */
  private async flushBoardEvents(state: HandState, cursor: number): Promise<number> {
    for (let i = cursor; i < state.events.length; i++) {
      const event = state.events[i];
      if (event.type === 'street') {
        await this.pause(STREET_BEAT_MS);
        this.publish({
          type: 'street',
          street: event.street,
          cards: event.cards.map(cardName),
          pot: totalPot(state),
        });
        this.note(`${capitalise(event.street)}: ${event.cards.map(cardName).join(' ')}`);
        // The bets have just swept into the pot and three new cards have
        // landed. Both are the reason the next decision reads the way it does,
        // so neither is allowed to be overwritten by it.
        await this.pause(STREET_SETTLE_MS);
      }
    }
    return state.events.length;
  }

  private async settleOnScreen(state: HandState, lineup: SeatedAgent[]): Promise<void> {
    const showdowns = state.events.filter((event) => event.type === 'showdown');
    if (showdowns.length > 0) await this.pause(SHOWDOWN_BEAT_MS);

    for (const event of showdowns) {
      if (event.type !== 'showdown') continue;
      const chair = this.chairOf(event.seat);
      this.shown.set(chair, [...event.hole]);
      const hand = describeHand(evaluate([...event.hole, ...state.board]));
      this.publish({ type: 'showdown', seat: chair, hole: event.hole.map(cardName), hand });
      this.note(`${lineup[event.seat]?.name ?? 'Seat'} shows ${event.hole.map(cardName).join(' ')}, ${hand}.`);
      await this.pause(REVEAL_BEAT_MS);
    }

    // Held whether or not anyone showed, because a pot won uncontested is
    // still a pot being pushed and it is the last thing to happen this hand.
    await this.pause(AWARD_BEAT_MS);

    for (const event of state.events) {
      if (event.type !== 'award') continue;
      const chair = this.chairOf(event.seat);
      this.won.set(chair, (this.won.get(chair) ?? 0) + event.amount);
      this.publish({
        type: 'award',
        seat: chair,
        amount: event.amount,
        uncontested: event.uncontested,
        stack: state.seats[event.seat].stack,
      });
      this.note(`${lineup[event.seat]?.name ?? 'Seat'} wins ${event.amount}.`, chair);
    }

    // The pot has just been pushed. Clearing the board on the same frame means
    // the only thing a spectator ever sees is an empty table.
    await this.pause(HAND_END_BEAT_MS);

    this.publish({
      type: 'hand-end',
      stacks: state.seats.map((seat) => ({ seat: this.chairOf(seat.index), stack: seat.stack })),
    });
  }

  private async persist(context: {
    lineup: SeatedAgent[];
    state: HandState;
    seed: number;
    startedAt: Date;
    recorded: Array<{ seatIndex: number; agentId: string; record: DecisionRecord; street: string }>;
  }): Promise<void> {
    const { lineup, state, seed, startedAt, recorded } = context;
    const potSize = totalPot(state);

    const handId = await saveHand({
      tableId: this.config.id,
      handNumber: this.handNumber,
      seed,
      state,
      startedAt,
      lineup: lineup.map((seat, position) => ({
        seatIndex: position,
        agentId: seat.agentId,
        name: seat.name,
        startingStack: seat.stack,
      })),
      decisions: recorded,
    });

    // Published as soon as it is stored, so a spectator can open the hand they
    // have just watched rather than waiting for a page to be reloaded.
    this.publish({ type: 'hand-stored', handId, handNumber: this.handNumber });

    await recordResults(
      lineup.map((seat, position) => {
        const finished = state.seats[position];
        const net = finished.stack - seat.stack;
        return { agentId: seat.agentId, won: net > 0, net, potSize };
      }),
    );

    await saveStacks(
      this.config.id,
      lineup.map((seat, position) => ({ seatIndex: seat.seatIndex, stack: state.seats[position].stack })),
    );

    // The hand is on record, so its chips are no longer in play and the seats
    // can be released. Anything after this point is bookkeeping.
    this.handLive = false;

    // A stack too short to post a big blind cannot play the next hand, so the
    // seat is released and whatever is left goes back to its owner's balance.
    // Owners who asked to leave mid-hand are released here for the same reason:
    // this is the first moment their stack is settled.
    for (const [position, seat] of lineup.entries()) {
      const busted = state.seats[position].stack < this.config.bigBlind;
      const recalled = this.pendingLeave.has(seat.agentId);
      if (!busted && !recalled) continue;

      await leaveSeat(this.config.id, seat.seatIndex);
      this.pendingLeave.delete(seat.agentId);
      this.note(
        busted ? `${seat.name} is out of chips and leaves the table.` : `${seat.name} was recalled by its owner.`,
        seat.seatIndex,
      );
    }
    this.pendingLeave.clear();
  }
}

/**
 * The next button position, following the chair the button was last in.
 *
 * Rotating a position instead would move the button by whatever the lineup
 * happens to be numbered today, which hands the same player the button twice
 * whenever a seat empties.
 */
function nextButtonPosition(lineup: SeatedAgent[], lastChair: number): number {
  const after = lineup.findIndex((seat) => seat.seatIndex > lastChair);
  return after >= 0 ? after : 0;
}

/**
 * Chip colour per chair, with collisions broken at the table.
 *
 * An agent keeps the colour it owns wherever possible, because colour is
 * identity. Two agents that happen to own the same colour cannot share a felt,
 * though, so the later chair takes the first colour nobody here is using.
 */
export function tablePalette(seated: SeatedAgent[]): Map<number, string> {
  const palette = new Map<number, string>();
  const used = new Set<string>();

  for (const seat of [...seated].sort((a, b) => a.seatIndex - b.seatIndex)) {
    const free = used.has(seat.color)
      ? (OPPONENT_COLORS.find((color) => !used.has(color.id))?.id ?? seat.color)
      : seat.color;
    used.add(free);
    palette.set(seat.seatIndex, free);
  }

  return palette;
}

function lastActionEvent(state: HandState, from: number): { action: string; amount: number; to: number } | null {
  for (let i = state.events.length - 1; i >= from; i--) {
    const event = state.events[i];
    if (event.type === 'action') return { action: event.action, amount: event.amount, to: event.to };
  }
  return null;
}

function describeAction(name: string, action: string, amount: number): string {
  switch (action) {
    case 'fold':
      return `${name} folds.`;
    case 'check':
      return `${name} checks.`;
    case 'call':
      return `${name} calls ${amount}.`;
    case 'bet':
      return `${name} bets ${amount}.`;
    case 'raise':
      return `${name} raises ${amount}.`;
    default:
      return `${name} acts.`;
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.message}${error.stack ? `\n${error.stack}` : ''}`.slice(0, 600) : 'unknown error';
}
