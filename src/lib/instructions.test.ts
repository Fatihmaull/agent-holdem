import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROMPT_BUDGETS, budgetsFor, checkInstructions, countWords } from './instructions';
import { TABLES } from './economy';

test('counts words, not tokens or characters', () => {
  assert.equal(countWords('Raise three times the blind with any pair.'), 8);
  assert.equal(countWords('  spaced   out    text  '), 3);
  assert.equal(countWords('line\nbreaks\tand\ttabs'), 4);
});

test('a hyphenated poker term is one word, as a writer would count it', () => {
  assert.equal(countWords('three-bet or fold'), 3);
  assert.equal(countWords('re-raise the turn'), 3);
  assert.equal(countWords("don't limp"), 2);
});

test('punctuation on its own never costs budget', () => {
  assert.equal(countWords('...'), 0);
  assert.equal(countWords('!!! ??? ---'), 0);
  assert.equal(countWords(''), 0);
  assert.equal(countWords('   '), 0);
});

test('counts non-English writing too', () => {
  assert.equal(countWords('naikkan taruhan dengan pasangan apa pun'), 6);
  assert.equal(countWords('加注 或者 弃牌'), 3);
});

test('a budget admits anything at or under it', () => {
  const ten = 'one two three four five six seven eight nine ten';
  assert.equal(countWords(ten), 10);
  assert.equal(checkInstructions(ten, 10).ok, true);
  assert.equal(checkInstructions(`${ten} eleven`, 10).ok, false);
});

test('rejection says how far over the writer is', () => {
  const result = checkInstructions('one two three four five six seven eight nine ten eleven twelve', 10);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.words, 12);
  assert.equal(result.budget, 10);
  assert.match(result.reason, /12 words/);
  assert.match(result.reason, /Cut 2/);
});

test('an agent with nothing written can still take a seat', () => {
  // Silence is a playing style the engine already handles; it should not be a
  // reason to keep someone out of the lobby.
  for (const budget of PROMPT_BUDGETS) {
    assert.equal(checkInstructions('', budget).ok, true);
  }
});

test('budgetsFor reports every table a text could sit at', () => {
  assert.deepEqual(budgetsFor('fold everything'), [10, 50, 100]);

  const thirty = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  assert.deepEqual(budgetsFor(thirty), [50, 100]);

  const twoHundred = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
  assert.deepEqual(budgetsFor(twoHundred), []);
});

test('every table in the roster carries a real budget', () => {
  for (const table of TABLES) {
    assert.ok(
      PROMPT_BUDGETS.includes(table.wordLimit),
      `${table.id} has budget ${table.wordLimit}, which is not one of the rooms`,
    );
  }
});

test('every budget is playable, and at more than one format', () => {
  // A budget that exists at only one table is a budget most players never get
  // to try, because that table is full.
  for (const budget of PROMPT_BUDGETS) {
    const tables = TABLES.filter((table) => table.wordLimit === budget);
    assert.ok(tables.length >= 2, `budget ${budget} has only ${tables.length} table(s)`);
    const formats = new Set(tables.map((table) => table.format));
    assert.ok(formats.size >= 2, `budget ${budget} exists only as ${[...formats].join(', ')}`);
  }
});
