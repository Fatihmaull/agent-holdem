import { cardName, type Card } from '../poker/cards';
import { applyAction, legalActions, startHand, totalPot, type HandState, type Street } from '../poker/engine';
import { describe as describeHand, evaluate } from '../poker/evaluate';
import { conservative } from '../lib/rating';
import { decide, reviseNotes, type DecisionRecord } from '../agent/decide';
import { OPPONENT_COLORS } from '../agent/colors';
import type { ModelProvider } from '../agent/provider';
import type { ModelQueue } from '../agent/queue';
import { type MatchConfig, stakesLabel } from '../lib/economy';
import {
  ACTION_BEAT_MS,
  ACT_CLOCK_MS,
  AWARD_BEAT_MS,
  BETWEEN_HANDS_MS,
  HAND_END_BEAT_MS,
  NOTE_CLOCK_MS,
  REVEAL_BEAT_MS,
  SHOWDOWN_BEAT_MS,
  STREET_BEAT_MS,
  STREET_SETTLE_MS,
  pacingFloor,
} from '../lib/pacing';
import { TableBus } from './bus';
import {
  bustSeat,
  clearInHand,
  loadNotes,
  loadSeats,
  markInHand,
  ratingsOf,
  recordResults,
  saveHand,
  saveNote,
  saveStacks,
  type MatchEnding,
  type SeatedAgent,
} from './store';
import type { ArenaEvent, BrainView, LogLine, SeatStatus, SeatView, TableView } from './view';

export class MatchRuntime {
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
  /** How the match ended, once it has. Null while it is still being played. */
  private ending: MatchEnding | null = null;
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
  /** Ratings of everyone in the match, read once when it opens. */
  private ratings = new Map<string, number>();
  private running = false;
  private stopping = new AbortController();

  constructor(
    readonly matchId: string,
    readonly config: MatchConfig,
    private readonly provider: ModelProvider,
    private readonly queue: ModelQueue,
    /** Called once the match is over, so the matchmaker can close it out. */
    private readonly onFinished: (matchId: string, ending: MatchEnding, hands: number) => void,
  ) {}

  /**
   * Reads the roster once, when the match opens.
   *
   * Nobody joins and nobody leaves a match, so this is not a refresh in the old
   * sense: the set of agents is fixed from the first hand to the last, which is
   * the whole reason a finishing order means anything.
   */
  private async loadRoster(): Promise<void> {
    this.seated = await loadSeats(this.matchId);
    this.ratings = new Map(
      [...(await ratingsOf(this.seated.map((seat) => seat.agentId)))].map(
        ([agentId, rating]) => [agentId, conservative(rating)],
      ),
    );

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

  /** Whether this agent is sitting in the hand being played right now. */
  isInLiveHand(agentId: string): boolean {
    return this.handLive && this.lineup.some((seat) => seat.agentId === agentId);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = new AbortController();
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.stopping.abort();
  }

  /**
   * The table as one viewer is entitled to see it. Hole cards belong to their
   * owner until a real showdown, so the redaction happens here rather than in
   * the browser where it would only be a suggestion.
   */
  view(viewerAgentId: string | null): TableView {
    return {
      matchId: this.matchId,
      label: `${stakesLabel()} match`,
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

  private async pause(ms: number): Promise<void> {
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
      await this.loadRoster();
    } catch (error) {
      console.error(`[${this.matchId}] cannot read the roster`, error);
      this.finish('abandoned');
      return;
    }

    while (this.running) {
      // Everyone but one is out of chips. That is the match, and it is over the
      // moment it happens rather than at the end of some tidier boundary.
      if (this.alive().length < 2) {
        this.finish('elimination');
        return;
      }

      if (this.handNumber >= this.config.handCap) {
        this.finish('cap');
        return;
      }

      try {
        await this.playHand();
      } catch (error) {
        // Spectators get a plain sentence; the detail goes to the server log,
        // because a driver's error text is not something to put on the ticker.
        console.error(`[${this.matchId}] hand ${this.handNumber} abandoned`, error);
        this.note('That hand could not be completed and was abandoned.');
      } finally {
        // Whatever happened, no hand is holding chips any more. Leaving either
        // of these set would strand the match: the flag until the next deal,
        // and the rows forever, because nothing else clears them.
        this.handLive = false;
        await clearInHand(this.matchId).catch((error) => {
          console.error(`[${this.matchId}] could not release the seats`, error);
        });
      }

      await this.pause(BETWEEN_HANDS_MS);
    }
  }

  /** Seats that still have chips to play with. */
  private alive(): SeatedAgent[] {
    return this.seated.filter((seat) => seat.bustedAtHand === null && seat.stack >= this.config.bigBlind);
  }

  /**
   * Stops dealing and hands the match back to be settled.
   *
   * The settling itself happens outside this runtime, because it moves chips
   * and updates ratings and none of that should be tangled up with the loop
   * that deals cards.
   */
  private finish(ending: MatchEnding): void {
    if (this.ending !== null) return;
    this.ending = ending;
    this.running = false;

    this.state = null;
    this.toAct = null;
    this.deadline = null;
    this.note(
      ending === 'elimination'
        ? 'One agent has everything. That is the match.'
        : ending === 'cap'
          ? `The hand limit is up after ${this.handNumber} hands.`
          : 'The match was abandoned.',
    );
    this.publish({ type: 'idle', reason: 'This match is over.' });

    this.onFinished(this.matchId, ending, this.handNumber);
  }

  /**
   * What each agent at this table remembers about the others, by author then
   * by subject. The control arm is simply absent, so it sits down knowing
   * nobody.
   */
  private async loadTableNotes(lineup: SeatedAgent[]): Promise<Map<string, Map<string, string>>> {
    const notes = new Map<string, Map<string, string>>();

    for (const reader of lineup) {
      if (!reader.notesEnabled) continue;
      const subjects = lineup.filter((seat) => seat.agentId !== reader.agentId).map((seat) => seat.agentId);
      try {
        notes.set(reader.agentId, await loadNotes(this.matchId, reader.agentId, subjects));
      } catch (error) {
        // A memory that will not load is one agent playing this hand blind,
        // which is a worse hand for that agent rather than a stalled table.
        console.error(`[${this.matchId}] could not read notes for ${reader.name}`, error);
      }
    }

    return notes;
  }

  private async playHand(): Promise<void> {
    // Only seats with chips left. Everyone else is eliminated and stays on the
    // record of where they finished rather than being dealt to.
    const seated = this.alive().sort((a, b) => a.seatIndex - b.seatIndex);

    // Claimed on the rows before a card exists, so nothing else can settle one
    // of these seats out from under a hand it is about to bet with. A seat that
    // could not be claimed is dropped rather than dealt to on a stale read.
    const claimed = new Set(await markInHand(this.matchId, seated.map((seat) => seat.seatIndex)));
    const lineup = seated.filter((seat) => claimed.has(seat.seatIndex));
    if (lineup.length < 2) {
      await clearInHand(this.matchId);
      this.finish('elimination');
      return;
    }

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
      handId: `${this.matchId}-${this.handNumber}`,
      seats: lineup.map((seat) => ({ agentId: seat.agentId, stack: seat.stack, sittingOut: false })),
      button,
      smallBlind: this.config.smallBlind,
      bigBlind: this.config.bigBlind,
      seed,
    });
    this.state = state;

    // Who was made to post what, so a seat that has not acted yet still has
    // something true to show rather than an empty line.
    for (const event of state.events) {
      if (event.type !== 'blind') continue;
      this.blinds.set(this.chairOf(event.seat), { kind: event.kind, amount: event.amount });
    }

    this.note(`Hand ${this.handNumber} dealt. Blinds ${this.config.smallBlind}/${this.config.bigBlind}.`);
    this.publish({
      type: 'hand-start',
      handNumber: this.handNumber,
      button: this.buttonChair,
      seats: this.seatViews(null),
    });

    // Read once for the hand. An agent only writes between hands, so its notes
    // cannot change while it is playing and re-reading them every turn would
    // fetch identical rows two or three times a hand.
    const notes = await this.loadTableNotes(lineup);

    const recorded: Array<{ seatIndex: number; agentId: string; record: DecisionRecord; street: string }> = [];
    let eventCursor = state.events.length;
    let street: Street = state.street;

    while (state.toAct !== null && this.running) {
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
        notes: notes.get(agent.agentId),
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
    const handId = await this.persist({ lineup, state, seed, startedAt, recorded });
    await this.writeNotes({ lineup, state, recorded, notes, handId });
  }

  /**
   * Gives every agent that asked during the hand its one look back at it.
   *
   * This is the only moment an agent can see cards that were turned over, which
   * is why the request happens here rather than inside the hand. Requests run
   * together rather than one after another: they are independent, and serialised
   * they could hold the table for as long as it takes several agents to write.
   */
  private async writeNotes(context: {
    lineup: SeatedAgent[];
    state: HandState;
    recorded: Array<{ agentId: string; record: DecisionRecord }>;
    notes: Map<string, Map<string, string>>;
    handId: string;
  }): Promise<void> {
    const { lineup, state, recorded, notes, handId } = context;

    const asked = new Set(
      recorded.filter((entry) => entry.record.remember === true).map((entry) => entry.agentId),
    );
    const writers = lineup.filter(
      (seat) => asked.has(seat.agentId) && seat.notesEnabled,
    );
    if (writers.length === 0) return;

    const hand = summariseHand(state, lineup);

    await Promise.all(
      writers.map(async (writer) => {
        // Absent means the read failed at the start of the hand, not that this
        // agent remembers nobody. Writing from here would show it a blank slate
        // and let it replace real notes with first impressions, so a hand whose
        // memory could not be read is a hand it does not get to rewrite.
        const held = notes.get(writer.agentId);
        if (held === undefined) return;

        const opponents = lineup
          .filter((seat) => seat.agentId !== writer.agentId)
          .map((seat) => ({ name: seat.name, note: held.get(seat.agentId) ?? null }));

        const { updates, failure } = await reviseNotes({
          agent: { id: writer.agentId, name: writer.name, instructions: writer.instructions },
          hand,
          opponents,
          clockMs: NOTE_CLOCK_MS,
          provider: this.provider,
          queue: this.queue,
          signal: this.stopping.signal,
        });

        if (failure) {
          console.error(`[${this.matchId}] ${writer.name} could not write its notes: ${failure}`);
          return;
        }

        // Names came back from the model, so they are matched against the seats
        // rather than trusted: a note is only ever written about somebody this
        // agent actually just played.
        const byName = new Map(lineup.map((seat) => [seat.name, seat.agentId]));
        for (const update of updates) {
          const subjectId = byName.get(update.name);
          if (subjectId === undefined || subjectId === writer.agentId) continue;
          try {
            await saveNote({ matchId: this.matchId, authorId: writer.agentId, subjectId, text: update.text, handId });
          } catch (error) {
            console.error(`[${this.matchId}] could not store a note for ${writer.name}`, error);
          }
        }
      }),
    );
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
  }): Promise<string> {
    const { lineup, state, seed, startedAt, recorded } = context;
    const potSize = totalPot(state);

    const handId = await saveHand({
      matchId: this.matchId,
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

    const dealtIn = state.seats.filter((seat) => !seat.sittingOut);
    const showdown = state.events.some((event) => event.type === 'showdown');

    await recordResults(
      { handId, matchId: this.matchId, bigBlind: this.config.bigBlind },
      lineup.flatMap((seat, position) => {
        const finished = state.seats[position];
        if (finished.sittingOut) return [];

        const net = finished.stack - seat.stack;
        return [
          {
            agentId: seat.agentId,
            won: net > 0,
            net,
            potSize,
            startingStack: seat.stack,
            showdown,
            opponents: dealtIn.length - 1,
            // A snapshot of how strong the opposition was, taken now rather
            // than joined later, because ratings move and asking next month how
            // good these opponents were would answer with next month's opinion.
            opponentRating: averageRating(
              dealtIn
                .filter((other) => other.index !== position)
                .map((other) => this.ratings.get(lineup[other.index]?.agentId ?? '')),
            ),
          },
        ];
      }),
    );

    await saveStacks(
      this.matchId,
      lineup.map((seat, position) => ({ seatIndex: seat.seatIndex, stack: state.seats[position].stack })),
    );

    // Carry the result back onto the roster this runtime deals from.
    //
    // The roster is read once, when the match opens, because nobody joins or
    // leaves after that. Which means nothing else ever updates it: without this
    // every hand would be dealt with everyone back at their buy-in, chips would
    // appear and vanish between hands, and the stored results would all claim a
    // starting stack of exactly the buy-in. The lineup entries are the same
    // objects as the roster's, so assigning here is what makes hand two follow
    // from hand one.
    for (const [position, seat] of lineup.entries()) {
      seat.stack = state.seats[position].stack;
    }

    // The chips are on record, so the seats stop belonging to the hand. Done
    // before anything below can fail: a seat left marked in-hand is a seat the
    // match can never settle, which strands its owner's stack.
    await clearInHand(this.matchId);
    this.handLive = false;

    // A stack too short to post a big blind cannot play another hand. Nobody
    // leaves a match, so an eliminated seat stays where it is with its finishing
    // hand recorded, which is what fixes the order among everyone who went out.
    for (const [position, seat] of lineup.entries()) {
      const stack = state.seats[position].stack;
      if (stack >= this.config.bigBlind) continue;

      await bustSeat(this.matchId, seat.seatIndex, this.handNumber);
      seat.bustedAtHand = this.handNumber;
      this.note(
        stack > 0
          ? `${seat.name} is down to ${stack} and cannot post a blind, finishing on hand ${this.handNumber}.`
          : `${seat.name} is out of chips, finishing on hand ${this.handNumber}.`,
        seat.seatIndex,
      );
    }

    return handId;
  }
}

/**
 * The next button position, following the chair the button was last in.
 *
 * Rotating a position instead would move the button by whatever the lineup
 * happens to be numbered today, which hands the same player the button twice
 * whenever a seat empties.
 */
/** Mean of the ratings we have, ignoring opponents that carry none. */
function averageRating(ratings: Array<number | undefined>): number {
  const known = ratings.filter((rating): rating is number => rating !== undefined);
  if (known.length === 0) return 0;
  return known.reduce((sum, rating) => sum + rating, 0) / known.length;
}

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

/**
 * The hand as a player who sat through it would recount it. Built from the
 * engine's own events rather than from the display log, so it carries what
 * happened rather than what the ticker had room for.
 *
 * Only cards the engine actually turned over appear here. A hand that was
 * mucked stays mucked, so an agent writing its notes knows exactly what the
 * table knows and nothing more.
 */
function summariseHand(state: HandState, lineup: SeatedAgent[]): string[] {
  const nameOf = (position: number) => lineup[position]?.name ?? `seat ${position + 1}`;
  const lines: string[] = [];

  for (const event of state.events) {
    switch (event.type) {
      case 'blind':
        lines.push(`${nameOf(event.seat)} posts the ${event.kind} blind, ${event.amount}.`);
        break;
      case 'street':
        lines.push(`${event.street}: ${event.cards.map(cardName).join(' ') || 'no new cards'}`);
        break;
      case 'action':
        lines.push(describeAction(nameOf(event.seat), event.action, event.amount));
        break;
      case 'showdown':
        lines.push(
          `${nameOf(event.seat)} shows ${event.hole.map(cardName).join(' ')} for ${describeHand(event.score)}.`,
        );
        break;
      case 'award':
        lines.push(
          event.uncontested
            ? `${nameOf(event.seat)} wins ${event.amount}, everyone else folded.`
            : `${nameOf(event.seat)} wins ${event.amount} at showdown.`,
        );
        break;
    }
  }

  return lines;
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
