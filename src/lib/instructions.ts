/**
 * Word budgets for owner instructions.
 *
 * A table's budget is the constraint the table is really about. Ten words and
 * a hundred words are different games: one forces a player to find the single
 * idea that matters, the other lets them write a decision tree. Stakes and
 * seat count say what a hand costs; the budget says what kind of thinking the
 * table rewards.
 *
 * This module is the only definition of what counts as a word, so the counter
 * under the textarea and the check that gates a seat can never disagree.
 */

export type PromptBudget = 10 | 50 | 100;

export const PROMPT_BUDGETS: readonly PromptBudget[] = [10, 50, 100];

interface BudgetCopy {
  /** Shown wherever a table is named. */
  label: string;
  /** One line on what the budget asks of a writer. */
  blurb: string;
}

const BUDGET_COPY: Record<PromptBudget, BudgetCopy> = {
  10: {
    label: 'Micro',
    blurb: 'Ten words. Every one has to earn its place.',
  },
  50: {
    label: 'Tactical',
    blurb: 'Room for a style and a few conditions on top of it.',
  },
  100: {
    label: 'Deep',
    blurb: 'Enough for real lines: what to do, and what to do about the reply.',
  },
};

export function budgetLabel(budget: PromptBudget): string {
  return BUDGET_COPY[budget].label;
}

export function budgetBlurb(budget: PromptBudget): string {
  return BUDGET_COPY[budget].blurb;
}

/**
 * Counts words the way a writer would.
 *
 * A word is a run starting with a letter or digit, so `re-raise` and `3-bet`
 * count once and stray punctuation counts for nothing. Apostrophes and hyphens
 * inside a run are part of it; a lone dash is not a word you can spend budget
 * on. Unicode-aware, because an owner may not write in English.
 */
export function countWords(text: string): number {
  const runs = text.normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}'’‑-]*/gu);
  return runs ? runs.length : 0;
}

export type InstructionCheck =
  | { ok: true; words: number }
  | { ok: false; words: number; budget: PromptBudget; reason: string };

/**
 * Gates a seat. Empty instructions are allowed: an agent with nothing written
 * plays a straightforward game rather than being locked out of the lobby.
 */
export function checkInstructions(text: string, budget: PromptBudget): InstructionCheck {
  const words = countWords(text);
  if (words <= budget) return { ok: true, words };
  return {
    ok: false,
    words,
    budget,
    reason: `Your instructions are ${words} words. This table allows ${budget}. Cut ${words - budget}.`,
  };
}

/** The budgets a piece of text could be seated under right now. */
export function budgetsFor(text: string): PromptBudget[] {
  const words = countWords(text);
  return PROMPT_BUDGETS.filter((budget) => words <= budget);
}
