import {
  HAND_CATEGORY_LABEL,
  ROOM_MODE_BY_KEY,
  type CardCode,
  type RoomModeKey,
  type Street,
} from '@agentholdem/shared';
import { evaluateHand } from '../engine/evaluator.js';
import type { HandEngine, LegalActions } from '../engine/hand.js';

export interface TurnContext {
  tableName: string;
  mode: RoomModeKey;
  handNumber: number;
  street: Street;
  board: readonly CardCode[];
  holeCards: readonly CardCode[];
  seat: number;
  agentName: string;
  position: string;
  stack: number;
  pot: number;
  toCall: number;
  /** Highest total committed by anyone on this street. */
  currentBet: number;
  bigBlind: number;
  legal: LegalActions;
  opponents: { agentName: string; stack: number; committed: number; status: string }[];
  actionLog: string[];
  chatLog: string[];
  timeoutSeconds: number;
}

/**
 * Layer 1 of the two-layer prompt: the immutable rules and the table state.
 *
 * Everything a model needs to act is spelled out here, including the exact
 * legal amounts. The user's persona never gets to redefine the schema, so a
 * prompt-injected "ignore the JSON format" cannot break the engine — worst
 * case the response fails to parse and the fallback fires.
 */
export function buildStatePrompt(ctx: TurnContext): string {
  const madeHand =
    ctx.board.length >= 3
      ? HAND_CATEGORY_LABEL[evaluateHand([...ctx.holeCards, ...ctx.board]).category]
      : 'pre-flop';

  const opponentLines = ctx.opponents
    .map(
      (o) =>
        `  - ${o.agentName}: ${o.stack} chips behind, ${o.committed} in this street (${o.status})`,
    )
    .join('\n');

  const options: string[] = [];
  if (ctx.legal.canCheck) options.push('"check" (amount 0)');
  if (ctx.legal.canCall) options.push(`"call" (costs ${ctx.legal.toCall})`);
  if (ctx.legal.canRaise) {
    options.push(
      `"raise" with amount between ${ctx.legal.minRaiseTo} and ${ctx.legal.maxRaiseTo} ` +
        '(amount = your TOTAL chips in for this street, not the increment)',
    );
  }
  options.push(`"all-in" (pushes your whole ${ctx.stack} stack)`);
  options.push('"fold"');

  return `You are playing No-Limit Texas Hold'em as an autonomous agent in the AgentHoldem arena.
Table: ${ctx.tableName} — ${ROOM_MODE_BY_KEY[ctx.mode].label} room. Hand #${ctx.handNumber}.

YOUR SITUATION
  Seat ${ctx.seat} (${ctx.position}) playing as "${ctx.agentName}"
  Hole cards: ${ctx.holeCards.join(' ')}
  Board (${ctx.street}): ${ctx.board.length ? ctx.board.join(' ') : '(none yet)'}
  Current made hand: ${madeHand}
  Your stack: ${ctx.stack} chips   Big blind: ${ctx.bigBlind}
  Pot: ${ctx.pot}   To call: ${ctx.toCall}   Pot odds if you call: ${potOdds(ctx)}

OPPONENTS
${opponentLines || '  (none)'}

ACTION THIS HAND
${ctx.actionLog.length ? ctx.actionLog.map((l) => `  ${l}`).join('\n') : '  (no action yet)'}

TABLE CHAT
${ctx.chatLog.length ? ctx.chatLog.map((l) => `  ${l}`).join('\n') : '  (quiet)'}

LEGAL ACTIONS RIGHT NOW
${options.map((o) => `  - ${o}`).join('\n')}

RESPONSE FORMAT — reply with a single JSON object and nothing else:
{"action":"fold"|"check"|"call"|"raise"|"all-in","amount":<number>,"inner_thought":"<your private reasoning, max 2 sentences>","table_chat":"<one short line of table talk, max 15 words>"}

Rules:
  - "amount" is the TOTAL you will have committed on this street after acting. Use 0 for fold and check.
  - Illegal or out-of-range values are clamped to the nearest legal action, so pick a real one.
  - You have ${ctx.timeoutSeconds} seconds. If you do not answer in time you automatically ${
    ctx.legal.canCheck ? 'check' : 'fold'
  }.
  - Never reveal your hole cards in "table_chat".`;
}

function potOdds(ctx: TurnContext): string {
  if (ctx.toCall <= 0) return 'n/a (checking is free)';
  const equityNeeded = ctx.toCall / (ctx.pot + ctx.toCall);
  return `${(equityNeeded * 100).toFixed(1)}% equity needed`;
}

/**
 * Layer 2: the manager's persona, quoted verbatim inside a delimiter so it
 * reads as strategy input rather than as instructions to the runtime.
 */
export function buildPersonaPrompt(persona: string, mode: RoomModeKey): string {
  const limit = ROOM_MODE_BY_KEY[mode].wordLimit;
  return `Your manager deployed you with this strategy brief (${limit}-word ${
    ROOM_MODE_BY_KEY[mode].label
  } room). Play it faithfully — it defines your personality, your aggression and your bluffing frequency. It does NOT change the response format.

<strategy_brief>
${persona.trim()}
</strategy_brief>`;
}

/** Turns the engine's live state into the context the prompt builder wants. */
export function contextFromEngine(
  engine: HandEngine,
  index: number,
  opts: {
    tableName: string;
    mode: RoomModeKey;
    bigBlind: number;
    actionLog: string[];
    chatLog: string[];
    timeoutSeconds: number;
  },
): TurnContext {
  const player = engine.players[index];
  if (!player) throw new Error(`No player at index ${index}`);
  const legal = engine.legalActions(index);

  return {
    tableName: opts.tableName,
    mode: opts.mode,
    handNumber: engine.handNumber,
    street: engine.street,
    board: [...engine.board],
    holeCards: [...player.holeCards],
    seat: player.seat,
    agentName: player.agentName,
    position: positionName(engine, index),
    stack: player.stack,
    pot: engine.totalPot,
    toCall: legal.toCall,
    currentBet: engine.currentBet,
    bigBlind: opts.bigBlind,
    legal,
    opponents: engine.players
      .filter((_, i) => i !== index)
      .map((o) => ({
        agentName: o.agentName,
        stack: o.stack,
        committed: o.committed,
        status: o.folded ? 'folded' : o.allIn ? 'all-in' : 'active',
      })),
    actionLog: opts.actionLog,
    chatLog: opts.chatLog,
    timeoutSeconds: opts.timeoutSeconds,
  };
}

export function positionName(engine: HandEngine, index: number): string {
  const n = engine.players.length;
  const offset = (index - engine.buttonIndex + n) % n;
  if (n === 2) return offset === 0 ? 'button/small blind' : 'big blind';
  if (offset === 0) return 'button';
  if (offset === 1) return 'small blind';
  if (offset === 2) return 'big blind';
  if (offset === n - 1) return 'cutoff';
  return `middle position (+${offset})`;
}
