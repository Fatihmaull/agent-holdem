import type { ActionType } from './poker.js';

/**
 * The exact JSON contract every agent turn must satisfy.
 *
 * Layer 1 of the prompt (table state) pins this schema; Layer 2 (the user's
 * persona template) is free-form prose. Anything the model returns that does
 * not parse into this shape is repaired once, retried once, then replaced by
 * the deterministic fallback (check when free, fold when facing a bet).
 */
export interface AgentDecision {
  action: ActionType;
  /** For `raise`: the total chips to have in front of you this street. */
  amount: number;
  inner_thought: string;
  table_chat: string;
}

export const AGENT_DECISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'amount', 'inner_thought', 'table_chat'],
  properties: {
    action: { type: 'string', enum: ['fold', 'check', 'call', 'raise', 'all-in'] },
    amount: { type: 'number', minimum: 0 },
    inner_thought: { type: 'string', maxLength: 400 },
    table_chat: { type: 'string', maxLength: 160 },
  },
} as const;

export type DecisionSource =
  | 'llm'
  | 'llm-retry'
  | 'fallback-timeout'
  | 'fallback-invalid'
  | 'fallback-error'
  | 'fallback-no-provider'
  | 'heuristic';

export interface AgentTurnResult {
  decision: AgentDecision;
  source: DecisionSource;
  /** Wall-clock ms spent on the whole turn including retries. */
  latencyMs: number;
  provider?: string;
  model?: string;
  error?: string;
}

/** A saved persona the manager deploys to tables. */
export interface PromptTemplate {
  id: string;
  ownerAddress: string;
  name: string;
  prompt: string;
  /** Word count at save time; recomputed server-side on enrolment. */
  words: number;
  createdAt: number;
  updatedAt: number;
  stats?: TemplateStats;
}

export interface TemplateStats {
  handsPlayed: number;
  handsWon: number;
  tablesEntered: number;
  chipsStaked: number;
  chipsReturned: number;
}

export const STARTER_TEMPLATES: readonly { name: string; prompt: string; mode: string }[] = [
  {
    name: 'The Mathematician',
    prompt: 'Play pot odds strictly. Fold marginal spots. Value bet relentlessly.',
    mode: 'micro',
  },
  {
    name: 'Aggressive Bully',
    prompt: 'Relentless pressure. Raise weakness, three-bet often, never limp.',
    mode: 'micro',
  },
  {
    name: 'Trap Master',
    prompt:
      'You are patient and deceptive. Slow-play your monsters: flat call with sets and top two pair on wet boards, then check-raise the turn hard. Fold anything speculative to real aggression. Talk humbly at the table so opponents read you as passive, then punish them when they over-commit. Never bluff more than one street.',
    mode: 'deep',
  },
] as const;
