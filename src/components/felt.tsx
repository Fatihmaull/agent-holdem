'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatChips } from '@/lib/economy';
import { ACT_CLOCK_MS } from '@/lib/pacing';
import type { SeatView, TableView } from '@/server/view';
import { CardBack, CardSlot, DealerButton, PlayingCard, agentHex, type CardOrigin } from './table-art';
import { seatLabel } from './use-table-stream';
import { Button } from './ui';

/**
 * The table itself: the cloth, the seats around it and the board in the middle.
 * Everything here is drawn for a spectator who is not playing, so nothing is
 * interactive and every figure is one somebody watching has to be able to read
 * before the next event replaces it.
 *
 * Only one thing on this table is drawn in an agent's own colour, and it is the
 * disc with the agent's initial in it. A colour per agent is fine for saying
 * whose seat this is and useless for saying what is happening at it: with six
 * agents the table ends up with six different "your turn" colours and none of
 * them means anything. State has one palette, the same at every seat.
 */

export function Felt({
  table,
  myAgentId,
  idleReason,
  moved,
  potKey,
  actionKeys,
  onSeat,
  canSeat,
}: {
  table: TableView | null;
  myAgentId: string | null;
  idleReason: string | null;
  /** Seats whose stack changed on the last event, so the figure settles once. */
  moved: number[];
  /** Steps whenever the pot changes, so the figure can react to money arriving. */
  potKey: number;
  /** Steps per seat on every action, so a repeated action still replays. */
  actionKeys: Record<number, number>;
  onSeat: () => void;
  canSeat: boolean;
}) {
  const felt = useRef<HTMLDivElement>(null);
  const box = useFeltBox(felt, table?.seats.length ?? 6);
  const flights = useChipFlights(table);

  const focus = table?.seats.findIndex((seat) => seat.agentId && seat.agentId === myAgentId) ?? -1;
  const anchor = focus >= 0 ? focus : 0;
  const seated = table?.seats.filter((seat) => seat.agentId).length ?? 0;

  return (
    <div
      // The ref stays on this element in every state. Handing back a different
      // element while the table loads leaves the observer with nothing to
      // attach to, and it never gets a second chance: the effect runs once.
      ref={felt}
      className="felt relative overflow-hidden rounded-card border border-line md:h-[var(--stage-h)]"
    >
      {!table ? (
        <div className="grid min-h-[26rem] place-items-center md:absolute md:inset-0 md:min-h-0">
          <p className="text-sm text-white/70">Opening the table…</p>
        </div>
      ) : (
        <>
          {/*
            The oval, drawn only where there is width to hold it. The cloth
            stays in percentages; only the objects sitting on it are scaled,
            because shrinking the layer as a whole would pull the seats together
            by exactly as much as it shrank them and fix nothing.
          */}
          <div className="absolute inset-0 hidden md:block">
            {/*
              Flatter than it is wide, by a lot. A poker table is that shape
              because the players sit along its sides, and an oval drawn any
              rounder pushes them into its ends and leaves its middle empty.

              The inset is not symmetric, because the seat ring it carries is
              not centred on the felt either. Cards stand above the plate they
              belong to, so the ring sits low and the cloth sits low with it,
              which is what leaves the seats at the top of the table room to
              hold a hand.
            */}
            <div className="cloth pointer-events-none absolute inset-[20%_5%_10%_5%]" aria-hidden />

            {table.seats.map((seat) => (
              <Seat
                key={seat.index}
                seat={seat}
                table={table}
                position={seatPosition(seat.index, anchor, table.seats.length)}
                // The avatar sits on the outer side of the plate, so a seat on
                // the left of the table is laid out the mirror of one on the
                // right and both read outwards from the cloth.
                mirrored={seatAngle(seat.index, anchor, table.seats.length).cos > 0.01}
                isMine={Boolean(seat.agentId && seat.agentId === myAgentId)}
                settling={moved.includes(seat.index)}
                actionKey={actionKeys[seat.index] ?? 0}
                // Cards are dealt out of the middle of the table, so a seat has
                // to know which way the middle is from where it sits.
                origin={dealOrigin(seat.index, anchor, table.seats.length, box)}
                box={box}
              />
            ))}

            <ChipFlights flights={flights} anchor={anchor} count={table.seats.length} box={box} />

            <div
              className="pointer-events-none absolute inset-x-0 flex -translate-y-1/2 justify-center"
              style={{ top: `${BOARD_TOP * 100}%` }}
            >
              <div
                className="flex flex-col items-center gap-2"
                style={{ transform: `scale(${box.scale})`, transformOrigin: 'center center' }}
              >
                <Centre table={table} potKey={potKey} />
              </div>
            </div>
          </div>

          {/* The same table as a column, for screens too narrow to hold an oval. */}
          <div className="flex flex-col items-center gap-2 py-6 md:hidden">
            <Centre table={table} potKey={potKey} />
          </div>

          <ul className="space-y-2 px-3 pb-4 md:hidden">
            {table.seats
              .filter((seat) => seat.agentId)
              .map((seat) => (
                <SeatRow
                  key={seat.index}
                  seat={seat}
                  table={table}
                  isMine={Boolean(seat.agentId && seat.agentId === myAgentId)}
                  actionKey={actionKeys[seat.index] ?? 0}
                />
              ))}
          </ul>

          {seated < 2 ? (
            <div className="absolute inset-0 z-20 grid place-items-center bg-black/55 px-6 backdrop-blur-[2px]">
              <div className="max-w-[34ch] text-center">
                <h2 className="text-lg text-white">
                  {seated === 0 ? 'No agents at this table yet' : 'Waiting for a second agent'}
                </h2>
                <p className="mt-2 text-sm text-white/70">
                  A hand needs two agents. Nothing is dealt until a second one sits down, and every seat here is
                  filled by somebody&rsquo;s agent rather than by the house.
                </p>
                {canSeat ? (
                  <Button tone="primary" className="mt-4" onClick={onSeat}>
                    Join this table
                  </Button>
                ) : null}
              </div>
            </div>
          ) : idleReason ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
              <p className="entering rounded-control bg-black/60 px-4 py-2 text-center text-sm text-white/90">
                {idleReason}
              </p>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** What is in the middle of the table: the money, and the cards everyone shares. */
function Centre({ table, potKey }: { table: TableView; potKey: number }) {
  const pot = useCountUp(table.pot);

  return (
    <>
      <div className="flex h-[3.25rem] flex-col items-center justify-end gap-1">
        {table.pot > 0 ? (
          <>
            <span className="text-[0.7rem] font-semibold tracking-[0.14em] text-white/45">POT</span>
            <div key={potKey} className="pot-hit flex items-center gap-2.5 rounded-full bg-black/45 px-4 py-1.5">
              <span className="chip-dot chip-dot-lg" aria-hidden />
              <span className="mono text-[1.25rem] leading-none font-semibold text-white tabular-nums">
                {formatChips(pot)}
              </span>
            </div>
          </>
        ) : null}
      </div>

      {/*
        The board sits in a recess cut into the cloth, and the recess is there
        before the flop as well: five empty boxes are the promise of a hand in
        progress, and holding them keeps the middle of the table from jumping
        when the flop lands.
      */}
      <div className="board-recess flex items-end gap-1.5 rounded-[10px] p-2">
        {table.board.map((card, index) => (
          // The flop arrives as three cards and is staggered; the turn and
          // the river arrive alone and have nothing to be staggered against.
          <PlayingCard
            key={`${card}-${index}`}
            card={card}
            size={66}
            delayMs={index < 3 ? index * 150 : 0}
            entrance="reveal"
          />
        ))}
        {Array.from({ length: 5 - table.board.length }, (_, i) => (
          <CardSlot key={`slot-${i}`} size={66} />
        ))}
      </div>
    </>
  );
}

/**
 * How far a seat reaches from the middle of its plate, at full size. The two
 * directions differ because a seat is not symmetric: cards stand well above the
 * plate, and below it there is only the action strip, which hangs off the
 * bottom edge and is one line high.
 */
const SEAT_UP = 72;
const SEAT_DOWN = 46;
/** The pot and the five board positions, at full size. */
const CENTRE_HEIGHT = 176;
/** Where the middle of the board sits, as a fraction of the felt's height. */
const BOARD_TOP = 0.5;
/**
 * Where the pot figure sits, in unscaled pixels above `BOARD_TOP`.
 *
 * The middle of the table is one column centred on `BOARD_TOP` and the pot is
 * the first thing in it, so the pot sits half the column's height up and then
 * back down by its own half. This is the only number here that is a measurement
 * of the layout rather than a decision about it, so it moves when the column
 * does: it is what chips aim at, and chips landing beside the figure they are
 * supposed to be joining is worse than no chips at all.
 */
const POT_ANCHOR_Y = -CENTRE_HEIGHT / 2 + 42;
/**
 * How far up and down the cloth the seats reach, and how far out to the sides,
 * as fractions of the felt. The cloth has far more width than height, which is
 * the whole reason a poker table is the shape it is.
 *
 * The ring has its own centre and it is not the board's. Cards are drawn above
 * the plate they belong to, so a seat reaches much further up than down, and
 * the ring has to sit low enough that the seat at the top of it still has felt
 * above its cards.
 */
const SEAT_CENTRE_Y = 0.55;
const SEAT_RADIUS = 0.4;
const SEAT_SPREAD = 0.4;
/**
 * Half a place of turn on the whole ring, so that no seat sits on the vertical
 * line through the middle of the table.
 *
 * That line is where the pot and the board are, and it is the one direction a
 * seat cannot give ground in: a seat above the board is squeezed against the
 * top of the felt and a seat below it has its cards pointing straight at the
 * board. Every format here seats an even number, so without the turn there is
 * always a seat at both ends of that line and both of them are in trouble.
 * Turned, the seats straddle it and the room they need comes out of the width,
 * which is the dimension a poker table has to spare.
 *
 * The cost is that the viewer's own seat is at the bottom corner rather than
 * the bottom middle. It is still the seat nearest the viewer and still the one
 * everything else is measured around.
 */
const SEAT_TURN = 0.5;
/**
 * Clear air kept around every seat, in unscaled pixels.
 *
 * Sizing the seats to fit exactly is sizing them to clip: a border, a shadow or
 * a font that measures a pixel taller than assumed has nowhere to go. This is
 * the slack that makes the fit a fit rather than a coincidence.
 */
const SEAT_MARGIN = 12;
/** Half the width of a seat, avatar included, and half the width of the board. */
const SEAT_HALF_WIDTH = 85;
const CENTRE_HALF_WIDTH = 185;

interface FeltBox {
  scale: number;
  width: number;
  height: number;
}

function useFeltBox(ref: React.RefObject<HTMLDivElement | null>, count: number): FeltBox {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((current) =>
        Math.abs(current.width - width) < 1 && Math.abs(current.height - height) < 1
          ? current
          : { width, height },
      );
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  // Derived rather than stored, because it depends on how many seats the table
  // has as well as how big the felt is, and a table can be looked at before its
  // first frame says how many that is.
  return { scale: feltScale(size.width, size.height, count), ...size };
}

/**
 * How large the objects on the cloth can be drawn in the room they have.
 *
 * Everything on the cloth is drawn at one size, so the fit is one number and
 * the worst-off seat decides it. Three things can take a seat's room away: the
 * top edge of the felt, the bottom edge, and the column of pot and board in the
 * middle. This walks the seats rather than assuming which one is worst, because
 * that depends on how many there are.
 *
 * The middle column is the interesting one. A seat clears it by being far
 * enough to the side of it or far enough above or below it, and either will do,
 * so the seat takes whichever is the more generous. That is what pays for
 * turning the ring: a seat pushed off the vertical line clears the board
 * sideways and stops competing with it for height.
 *
 * Scaling the whole layer instead would be no help at all: it would pull the
 * seats together by exactly as much as it shrank them.
 */
function feltScale(width: number, height: number, count: number): number {
  // Below the breakpoint the oval is not drawn and the seats are a list that
  // reflows on its own, so there is nothing there to scale.
  if (width < 768 || height === 0) return 1;

  const boardY = BOARD_TOP * height;
  const boardHalf = CENTRE_HEIGHT / 2;
  let room = Infinity;

  for (let index = 0; index < count; index += 1) {
    const { cos, sin } = seatAngle(index, 0, count);
    const y = (SEAT_CENTRE_Y + SEAT_RADIUS * sin) * height;
    const x = Math.abs(SEAT_SPREAD * cos) * width;

    // A seat below the board points its cards at it; one above it turns only
    // its foot that way. Which end faces the board decides how much room the
    // seat needs to clear it, and how much it needs to clear the felt itself.
    const towards = y > boardY ? SEAT_UP : SEAT_DOWN;
    const beside = x / (SEAT_HALF_WIDTH + CENTRE_HALF_WIDTH + SEAT_MARGIN);
    const clear = Math.abs(y - boardY) / (towards + boardHalf + SEAT_MARGIN);

    room = Math.min(
      room,
      y / (SEAT_UP + SEAT_MARGIN),
      (height - y) / (SEAT_DOWN + SEAT_MARGIN),
      Math.max(beside, clear),
    );
  }

  return Math.max(0.55, Math.min(1, room));
}

/** The middle of the felt, and the pot inside it, in the felt's own pixels. */
function centreOf(box: FeltBox): { x: number; y: number } {
  return { x: box.width / 2, y: BOARD_TOP * box.height + POT_ANCHOR_Y * box.scale };
}

/** Where a seat sits, in the felt's own pixels rather than in percentages. */
function seatPoint(index: number, anchor: number, count: number, box: FeltBox): { x: number; y: number } {
  const { cos, sin } = seatAngle(index, anchor, count);
  return { x: (0.5 + SEAT_SPREAD * cos) * box.width, y: (SEAT_CENTRE_Y + SEAT_RADIUS * sin) * box.height };
}

/**
 * The offset from a seat's cards back to the middle of the table.
 *
 * In that seat's own pixels, not the felt's. Everything inside a seat is drawn
 * through `scale`, so a translate written there covers `scale` times the ground
 * it says it does and has to be divided back out first. Before the felt has
 * been measured there is no direction to give, and a card with no origin falls
 * into place instead, which is what it did before any of this existed.
 */
function dealOrigin(index: number, anchor: number, count: number, box: FeltBox): CardOrigin | null {
  if (box.width === 0) return null;
  const seat = seatPoint(index, anchor, count, box);
  return {
    x: (box.width / 2 - seat.x) / box.scale,
    y: (BOARD_TOP * box.height - seat.y) / box.scale,
  };
}

/**
 * One seat: a disc on the outer side and a plate reading inwards from it.
 *
 * The plate is the fixed part and everything else hangs off it. That matters
 * more than it sounds, because an empty seat has no cards and no anything, and
 * if the plate were laid out in flow beneath them then half the table would sit
 * at one height and half at another. Six plates on one line is what makes a
 * table scannable.
 */
function Seat({
  seat,
  table,
  position,
  mirrored,
  isMine,
  settling,
  actionKey,
  origin,
  box,
}: {
  seat: SeatView;
  table: TableView;
  position: { left: string; top: string };
  /** True on the right of the table, where the disc goes on the right. */
  mirrored: boolean;
  isMine: boolean;
  settling: boolean;
  /** Steps on every action by this seat, so a repeated action still replays. */
  actionKey: number;
  /** Which way the middle of the table is, so cards can come from it. */
  origin: CardOrigin | null;
  /** How much of its full size this seat has room for. See `useFeltBox`. */
  box: FeltBox;
}) {
  const thinking = table.toAct === seat.index;
  const folded = seat.status === 'folded';
  const won = (seat.won ?? 0) > 0;
  const cards = seat.hole ?? (table.street === 'idle' ? null : FACE_DOWN);
  const leaving = useMuck(cards);
  // The plate reaches over the strip rather than containing it, so it has to
  // know whether there is one before it draws its own edge.
  const line = stripLine(seat, seat.won);

  return (
    <div
      // The positioning transform lives here and the sizing one on the child,
      // so neither can quietly overwrite the other.
      className="absolute -translate-x-1/2 -translate-y-1/2"
      style={{ left: position.left, top: position.top, zIndex: thinking || won ? 12 : 10 }}
    >
      <div
        className={`relative flex items-center ${mirrored ? 'flex-row-reverse' : ''}`}
        style={{ transform: `scale(${box.scale})`, transformOrigin: 'center center' }}
      >
        {seat.agentId ? (
          <>
            <Avatar
              seat={seat}
              isMine={isMine}
              deadline={thinking ? table.deadline : null}
              className={mirrored ? '-ml-3.5' : '-mr-3.5'}
            />

            {/*
              The hand is a sister of the plate rather than a child of it, and
              it comes first: the cards stand behind the plate and tuck their
              bottom edge under it, and painting order is what puts them there.
              A child of the plate would draw over the plate whatever z-index
              it carried.
            */}
            <div className="relative">
              {/*
                Face-up cards at a seat that is not yours only ever got there by
                being shown, so they turn over. Your own were dealt to you face
                up and were never anything else, so they are dealt.
              */}
              <Hand cards={cards} leaving={leaving} folded={folded} origin={origin} reveal={!isMine} />

              <div
                className={`plate relative w-[8.75rem] ${line ? 'has-strip' : ''} ${
                  thinking ? 'plate-live' : ''
                } ${won ? 'plate-won' : ''} ${folded ? 'plate-out' : ''}`}
              >
                {/*
                  Centred in the room the avatar leaves rather than in the
                  plate, so the type reads as centred to an eye that sees the
                  disc as part of the seat.
                */}
                <div className={`px-2.5 pt-1.5 pb-1.5 text-center ${mirrored ? 'pr-4' : 'pl-4'}`}>
                  <div className="truncate text-[0.6875rem] leading-tight font-semibold tracking-[0.06em] text-white/50 uppercase">
                    {seatLabel(seat)}
                  </div>
                  <StackFigure stack={seat.stack} settling={settling} />
                </div>

                {line ? <ActionStrip key={actionKey} line={line} /> : null}

                {/* The button rides the inner edge of the plate, off the type. */}
                {seat.isDealer ? (
                  <span
                    className={`dealer-pin absolute top-1/2 -translate-y-1/2 ${
                      mirrored ? '-left-2.5' : '-right-2.5'
                    }`}
                  >
                    <DealerButton size={18} />
                  </span>
                ) : null}
              </div>
            </div>
          </>
        ) : (
          <div className="plate plate-open grid h-[2.75rem] w-[8.75rem] place-items-center">
            <span className="text-xs text-white/25">Open seat</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Two cards nobody at this table is entitled to see yet. */
const FACE_DOWN = [null, null];

/**
 * A seat's hand, sitting square on the top edge of its plate.
 *
 * Squarely, not fanned. Card art has a printed border and a rounded corner, and
 * tilting one against the other puts those borders out of parallel, which reads
 * as a rendering fault rather than as a hand of cards.
 *
 * Cards nobody may see only have to say that this seat is still in the hand, so
 * they stay small. Cards that have been turned over, or that belong to the
 * person watching, have to be read, so they are drawn larger.
 *
 * A folded hand stays where it was and goes dim. Cards that vanish take the
 * seat's shape with them, and a row of plates that changes height as the hand
 * plays out is harder to read than one that dims in place.
 */
function Hand({
  cards,
  leaving,
  folded,
  origin,
  reveal,
}: {
  cards: Array<string | null> | null;
  /** The hand this seat had a moment ago, on its way off the table. */
  leaving: Array<string | null> | null;
  folded: boolean;
  origin: CardOrigin | null;
  /** True where a face-up card got that way by being turned over. */
  reveal: boolean;
}) {
  // The cards keep their keys across the change, so the hand that is leaving is
  // the same elements swapping animation rather than a new pair appearing.
  const showing = cards ?? leaving;
  if (!showing) return null;
  const shown = showing[0] !== null;
  const gone = cards === null;

  return (
    <div className="pointer-events-none absolute bottom-[calc(100%-3px)] left-1/2 flex -translate-x-1/2 gap-1">
      {showing.map((card, index) =>
        card === null ? (
          <CardBack key={index} size={38} delayMs={index * 110} origin={origin} leaving={gone} dimmed={folded} />
        ) : (
          <PlayingCard
            key={card}
            card={card}
            size={shown ? 44 : 38}
            delayMs={index * 110}
            origin={origin}
            entrance={reveal ? 'reveal' : 'deal'}
            leaving={gone}
            dimmed={folded}
          />
        ),
      )}
    </div>
  );
}

/**
 * The hand a seat had a moment ago, held just long enough to be seen leaving.
 *
 * The end of a hand takes every seat's cards away by giving it nothing to draw,
 * and nothing to draw is not something anybody can watch happen. Cards at a
 * real table go somewhere when they stop being in play, so they are held here
 * long enough to be seen going. A fold does not come through here: those cards
 * stay on the plate and dim instead.
 */
const MUCK_MS = 380;

type Cards = Array<string | null> | null;

function useMuck(cards: Cards): Cards {
  // Every event rebuilds the seat, so the array is a new one on every render
  // and its contents are what actually changed. Keying on those is the
  // difference between mucking once and mucking on every frame of a hand.
  const key = cards ? cards.map((card) => card ?? '?').join(' ') : '';
  const [state, setState] = useState<{ key: string; cards: Cards; leaving: Cards }>({ key, cards, leaving: null });

  // Worked out while rendering rather than in an effect. The hand leaving is
  // derived from the hand that is there, and an effect would draw the seat
  // empty for a frame before putting the cards back to take them away.
  if (state.key !== key) {
    const going = cards === null && state.cards !== null && !stillness();
    setState({ key, cards, leaving: going ? state.cards : null });
  }

  // Clearing it is the one part that really is a timer: nothing else knows
  // when the cards have finished leaving.
  useEffect(() => {
    if (state.leaving === null) return;
    const timer = setTimeout(() => setState((current) => ({ ...current, leaving: null })), MUCK_MS);
    return () => clearTimeout(timer);
  }, [state.leaving]);

  return cards === null ? state.leaving : null;
}

/**
 * The disc, and the only place an agent's own colour is used. It is muted well
 * down from the chip it is sampled from: six saturated discs around a table is
 * a set of warning lights, and none of them is telling you anything.
 *
 * The act clock is the ring around it, because the seat you are watching and
 * the clock you are watching it against should not be in two different places.
 */
function Avatar({
  seat,
  isMine,
  deadline,
  className = '',
}: {
  seat: SeatView;
  isMine: boolean;
  deadline: number | null;
  className?: string;
}) {
  const remaining = useRemaining(deadline);
  const fraction = deadline ? Math.max(0, Math.min(1, remaining / ACT_CLOCK_MS)) : 0;
  const hex = agentHex(isMine ? 'white' : seat.color);

  return (
    <span
      className={`relative z-[1] grid h-11 w-11 shrink-0 place-items-center rounded-full ${className}`}
      style={{
        background: deadline
          ? `conic-gradient(from 0deg, var(--color-live) ${fraction * 360}deg, rgba(0,0,0,0.5) 0)`
          : 'rgba(6, 18, 15, 0.92)',
      }}
    >
      <span
        className="grid h-[2.2rem] w-[2.2rem] place-items-center rounded-full text-sm font-semibold text-white/90"
        style={{ background: `color-mix(in srgb, ${hex} 42%, #16241f)` }}
      >
        {deadline ? (
          <span className="mono text-live tabular-nums">{Math.ceil(remaining / 1000)}</span>
        ) : (
          initialOf(seat.name)
        )}
      </span>
    </span>
  );
}

function initialOf(name: string | null): string {
  return name?.trim().charAt(0).toUpperCase() || '?';
}

/**
 * What a seat has left. The number and nothing else: a bar beside it was one
 * more thing to read that never said anything the number had not already said.
 */
function StackFigure({ stack, settling }: { stack: number; settling: boolean }) {
  const shown = useCountUp(stack);
  return (
    <div
      className={`mono text-[0.95rem] leading-tight font-semibold text-white tabular-nums ${
        settling ? 'settling' : ''
      }`}
    >
      {formatChips(shown)}
    </div>
  );
}

/**
 * What this seat last did, hanging off the bottom edge of its plate.
 *
 * The plate itself is only as tall as the name and the figure, so this arrives
 * by sliding out from under it instead of by making it taller: a seat that has
 * nothing to say is a smaller object than one that is talking, and the moment
 * it starts talking is the moment worth catching out of the corner of an eye.
 */
function ActionStrip({ line, inline = false }: { line: StripLine; inline?: boolean }) {
  // In a row it is a pill beside the name rather than the foot of a plate, so
  // it is rounded all the way round and has no plate to line its corners up to.
  if (inline) {
    return <strong className={`strip strip-inline ${line.tone} ${line.fresh ? 'badge-pop' : ''}`}>{line.body}</strong>;
  }

  // The mask is one line high and clips, so the strip is out of sight behind
  // the plate until it drops.
  return (
    <span className="strip-mask">
      <strong className={`strip ${line.tone} ${line.fresh ? 'strip-drop' : ''}`}>{line.body}</strong>
    </span>
  );
}

/**
 * The one sentence a seat is saying, or nothing at all when it has none.
 *
 * It changes rarely enough to be worth reading every time it does: what a seat
 * won outranks what it last did, and being out of the hand outlasts both,
 * because the badge that said "fold" is cleared when the street sweeps and
 * without this a seat that is out looks exactly like one that is waiting.
 *
 * `fresh` marks the lines that arrive because the seat just did something, as
 * against the ones that only describe where it stands. Those are the ones that
 * animate; a seat that has been folded for a minute does not re-announce it.
 */
type StripLine = { tone: string; body: ReactNode; fresh: boolean };

function stripLine(seat: SeatView, won: number | null): StripLine | null {
  if (won && won > 0) {
    return { tone: 'strip-won', body: `+${formatChips(won)}`, fresh: true };
  }

  if (seat.lastAction) {
    const kind = seat.status === 'all-in' ? 'all-in' : seat.lastAction;
    const total = seat.lastActionTo ?? 0;
    // Chips going in is the only distinction that changes how the next seat has
    // to think, so it is the only one drawn in colour.
    const money = kind !== 'fold' && kind !== 'check' && total > 0;
    return {
      tone: money ? 'strip-money' : 'strip-quiet',
      fresh: true,
      body: (
        <>
          {VERB[kind] ?? kind}
          {money ? <span className="mono ml-1.5 tabular-nums">{formatChips(total)}</span> : null}
        </>
      ),
    };
  }

  // Being made to post is not acting, so it ranks below anything the seat chose
  // to do. It is still worth a line: a seat that has not acted yet is not the
  // same as one that is already in for a blind.
  if (seat.blind) {
    return {
      // Green like a call or a raise, because chips went in either way. The
      // difference is only whether the seat chose to put them there.
      tone: 'strip-money',
      fresh: false,
      body: (
        <>
          {seat.blind.kind === 'small' ? 'Small blind' : 'Big blind'}
          <span className="mono ml-1.5 tabular-nums">{formatChips(seat.blind.amount)}</span>
        </>
      ),
    };
  }

  if (seat.status === 'folded') return { tone: 'strip-quiet', body: 'Folded', fresh: false };
  return null;
}

/** "raise" is what the engine calls it; "raise to" is what a player reads. */
const VERB: Record<string, string> = {
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  bet: 'Bet',
  raise: 'Raise to',
  'all-in': 'All in',
};

/** The same seat as a row, for a screen too narrow to hold an oval. */
function SeatRow({
  seat,
  table,
  isMine,
  actionKey,
}: {
  seat: SeatView;
  table: TableView;
  isMine: boolean;
  actionKey: number;
}) {
  const thinking = table.toAct === seat.index;
  const folded = seat.status === 'folded';
  const rowLine = stripLine(seat, seat.won);

  return (
    <li
      className={`plate flex items-center gap-2.5 p-2.5 ${thinking ? 'plate-live' : ''} ${
        folded ? 'plate-out' : ''
      }`}
    >
      <Avatar seat={seat} isMine={isMine} deadline={thinking ? table.deadline : null} />

      <div className="min-w-0 flex-1">
        <div className="truncate text-[0.6875rem] font-semibold tracking-[0.06em] text-white/50 uppercase">
          {seatLabel(seat)}
        </div>
        <div className="mono text-sm font-semibold text-white tabular-nums">{formatChips(seat.stack)}</div>
      </div>

      {seat.isDealer ? <DealerButton size={16} /> : null}

      <div className="w-[6.5rem] shrink-0">
        {rowLine ? <ActionStrip key={actionKey} line={rowLine} inline /> : null}
      </div>

      <div className="flex gap-1">
        {seat.hole ? (
          seat.hole.map((card) => <PlayingCard key={card} card={card} size={26} dimmed={folded} />)
        ) : (
          <>
            <CardBack size={26} dimmed={folded} />
            <CardBack size={26} dimmed={folded} />
          </>
        )}
      </div>
    </li>
  );
}

function useRemaining(deadline: number | null): number {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    // Every seat calls this and only one of them is on the clock. Ticking for
    // the other five is five timers running to report a number nobody reads.
    if (!deadline) return;
    const tick = () => setRemaining(Math.max(0, deadline - Date.now()));
    tick();
    const timer = setInterval(tick, 100);
    return () => clearInterval(timer);
  }, [deadline]);

  // Read through rather than stored, so a seat that has stopped acting reports
  // nothing left on the clock without waiting for a render to clear it.
  return deadline ? remaining : 0;
}

/**
 * Chips crossing the cloth, read off the table rather than off the feed.
 *
 * What makes a chip travel is money changing places, and there are only two
 * places it goes: a seat's commitment growing is chips going into the middle,
 * and a seat's winnings growing is the middle coming back. Deriving it from the
 * view means every route into the view moves chips — an action, a blind, a
 * reconnect — and no new event type has to remember to.
 *
 * The token stays a token. The figures on the plate and in the middle are the
 * exact answer to how much moved, and a countable pile of chips beside them
 * would be a second, worse one.
 */
const FLIGHT_MS = 620;
/** Three chips, thrown a beat apart, because one chip on its own is a cursor. */
const FLIGHT_CHIPS = [0, 1, 2];
const FLIGHT_LEAD = 70;

interface Flight {
  id: number;
  seat: number;
  /** `bet` runs seat to middle; `award` runs middle to seat. */
  kind: 'bet' | 'award';
}

/** What each seat has put in and taken out, which is all a flight is read from. */
type Totals = Map<number, { committed: number; won: number }>;

interface FlightState {
  /** The view these were worked out from, so the same view is not read twice. */
  source: TableView | null;
  totals: Totals;
  flights: Flight[];
  /** Ids, so two chips leaving the same seat are still two different chips. */
  serial: number;
}

function totalsOf(table: TableView | null): Totals {
  return new Map(
    (table?.seats ?? []).map((seat) => [seat.index, { committed: seat.committed ?? 0, won: seat.won ?? 0 }]),
  );
}

function advance(state: FlightState, table: TableView | null): FlightState {
  const totals = totalsOf(table);
  const started: Flight[] = [];
  let serial = state.serial;

  if (!stillness()) {
    for (const [index, now] of totals) {
      // A seat we are seeing for the first time has nothing to be compared
      // against, so joining a table mid-hand does not replay its betting.
      const was = state.totals.get(index);
      if (!was) continue;
      if (now.committed > was.committed) started.push({ id: serial++, seat: index, kind: 'bet' });
      if (now.won > was.won) started.push({ id: serial++, seat: index, kind: 'award' });
    }
  }

  return {
    source: table,
    totals,
    serial,
    // Kept as the same array when nothing set off, so the clearing timer below
    // is not restarted by every event that happens to change nothing.
    flights: started.length === 0 ? state.flights : [...state.flights, ...started].slice(-12),
  };
}

function useChipFlights(table: TableView | null): Flight[] {
  const [state, setState] = useState<FlightState>(() => ({
    source: table,
    totals: totalsOf(table),
    flights: [],
    serial: 0,
  }));

  if (state.source !== table) setState(advance(state, table));

  // The chips hold their finished frame, which is nothing, so clearing them
  // late is invisible and one timer for the whole set is enough.
  useEffect(() => {
    if (state.flights.length === 0) return;
    const timer = setTimeout(
      () => setState((current) => ({ ...current, flights: [] })),
      FLIGHT_MS + FLIGHT_CHIPS.length * FLIGHT_LEAD,
    );
    return () => clearTimeout(timer);
  }, [state.flights]);

  return state.flights;
}

function ChipFlights({
  flights,
  anchor,
  count,
  box,
}: {
  flights: Flight[];
  anchor: number;
  count: number;
  box: FeltBox;
}) {
  if (box.width === 0 || flights.length === 0) return null;
  const middle = centreOf(box);
  const size = 14 * box.scale;

  return (
    // Above the seats rather than between them: a chip that passes behind a
    // nameplate on its way to the pot has gone under the table.
    <div className="pointer-events-none absolute inset-0 z-[15]" aria-hidden>
      {flights.map((flight) => {
        const seat = seatPoint(flight.seat, anchor, count, box);
        const toMiddle = flight.kind === 'bet';
        const rest = toMiddle ? middle : seat;
        const from = toMiddle ? seat : middle;

        return (
          // The chips finish at rest and start at `from`, so the element is
          // parked where the money ends up and the animation is the journey.
          <div key={flight.id} className="absolute" style={{ left: rest.x, top: rest.y, width: 0, height: 0 }}>
            {FLIGHT_CHIPS.map((index) => (
              <span
                key={index}
                className="chip-flight absolute"
                style={
                  {
                    left: -size / 2,
                    top: -size / 2,
                    width: size,
                    height: size,
                    animationDelay: `${index * FLIGHT_LEAD}ms`,
                    '--fly-x': `${Math.round(from.x - rest.x)}px`,
                    '--fly-y': `${Math.round(from.y - rest.y)}px`,
                  } as React.CSSProperties
                }
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Anybody who has asked for less motion gets the state and none of the travel. */
function stillness(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Chip counts roll to their new value instead of snapping to it.
 *
 * A pot that jumps from 120 to 640 between frames reads as a different number
 * appearing; one that travels there reads as money arriving, and the travel is
 * what tells a spectator how much moved without doing the subtraction. Anyone
 * who has asked for less motion gets the number and none of the travel.
 */
const COUNT_MS = 420;

function useCountUp(value: number): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const frame = useRef(0);

  useEffect(() => {
    const start = from.current;
    if (stillness() || start === value) {
      from.current = value;
      setShown(value);
      return;
    }

    const startedAt = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - startedAt) / COUNT_MS);
      // Ease out, so the number lands rather than stopping dead.
      const eased = 1 - (1 - t) ** 3;
      setShown(Math.round(start + (value - start) * eased));
      if (t < 1) frame.current = requestAnimationFrame(step);
      else from.current = value;
    };

    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
  }, [value]);

  return shown;
}

/** Seats sit on an ellipse, rotated so the viewer's own agent is always at the bottom. */
function seatPosition(index: number, anchor: number, count: number): { left: string; top: string } {
  const { cos, sin } = seatAngle(index, anchor, count);
  return { left: `${50 + SEAT_SPREAD * 100 * cos}%`, top: `${SEAT_CENTRE_Y * 100 + SEAT_RADIUS * 100 * sin}%` };
}

function seatAngle(index: number, anchor: number, count: number): { cos: number; sin: number } {
  const step = ((index - anchor + count) % count) / count;
  const angle = Math.PI / 2 + (step + SEAT_TURN / count) * Math.PI * 2;
  return { cos: Math.cos(angle), sin: Math.sin(angle) };
}
