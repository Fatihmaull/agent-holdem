# Architecture

A walkthrough of how a hand actually gets played, module by module.

## The shape of the thing

```
packages/shared ──────┬──▶ apps/server   (game engine, LLM worker, WS + REST)
                      ├──▶ apps/web      (Next.js 14 App Router)
                      └──▶ contracts     (ABI is generated back into shared)
```

`@agentholdem/shared` exists because three separate programs have to agree on
the same numbers. Chip tiers, room word budgets, the WebSocket message union,
the agent JSON schema and the contract ABI all live there, and both other
workspaces import them rather than re-declaring.

---

## 1. The engine (`apps/server/src/engine`)

### `cards.ts`

A seeded PRNG (mulberry32) drives a Fisher-Yates shuffle. Determinism is the
point: each hand publishes `sha256(seed)` before the deal and the seed after,
and `layoutDeal` documents the exact deal order (hole cards one at a time
around the table, then burn/flop, burn/turn, burn/river) so a spectator can
replay the shuffle and verify the board.

### `evaluator.ts`

Seven-card evaluation reduced to a single integer. Category in the most
significant base-15 digit, then up to five tiebreakers, highest first — so
`a.score - b.score` is the complete comparator including exact chops. It
detects the flush suit first, checks for a straight flush inside it, then walks
rank multiplicities down to high card. Straights (including the wheel) come out
of a bitmask.

Duplicate cards throw rather than ranking. A duplicate means the deck logic is
broken, and returning a plausible-looking rank would hide that.

### `hand.ts`

One hand of no-limit hold'em as a synchronous, side-effect-free state machine.
The runner asks for `currentActor()`, gets a decision, calls `applyAction()`,
and drains `takeEvents()`. That split is what lets a table run with nobody
watching — nothing in here depends on a socket.

The parts that are easy to get wrong, and how they are handled:

- **Blinds and order.** Heads-up the button posts the small blind and acts
  first pre-flop, then the big blind acts first post-flop. Three-handed and up,
  blinds sit left of the button, UTG opens, and post-flop starts at the small
  blind. The big blind always gets its option.
- **Min-raise.** A raise must be to at least `currentBet + lastFullRaiseSize`.
- **Short all-ins.** An all-in smaller than a full raise does not reopen the
  betting. Players who already acted are marked `raiseLocked`: they may call or
  fold, not re-raise. A full raise clears every lock.
- **Side pots.** Built from each player's total investment at showdown. Chips
  from folded players stay in the pots they helped build; they are simply not
  eligible to win them. Pots with identical eligibility are merged so the UI
  shows "main plus one side pot", not four fragments.
- **Uncalled bets.** Fall out of the side-pot algorithm for free: the top
  contributor ends up as the sole eligible player for the excess.
- **Odd chips.** Split pots pay whole chips; the remainder goes to the first
  winner left of the button.

`legalize()` maps whatever the model asked for onto the nearest legal action —
a 3bb raise with 2bb behind becomes a shove, a check facing a bet becomes a
fold, a fold when checking is free becomes a check (which is what every online
room does). Amounts are re-derived from the engine's own rules, so a
hallucinated raise size can never move more chips than a player has.

---

## 2. The agent worker (`apps/server/src/llm`)

### `promptBuilder.ts`

Layer 1 is the table state and the rules, including the exact legal amounts and
the pot odds. Layer 2 is the manager's brief, wrapped in a
`<strategy_brief>` delimiter so it reads as strategy input. The persona never
gets to redefine the response schema; worst case a prompt-injected brief makes
the response unparseable, and the fallback fires.

### `provider.ts`

Groq via the OpenAI-compatible `chat/completions` endpoint with
`response_format: json_object`; Gemini via `generateContent` with
`responseMimeType: application/json`. `parseDecision` then does the repair
work: strips fences, scans for the first *balanced* `{...}` (ignoring braces
inside string literals), coerces numeric strings, and normalises action
synonyms (`shove`/`jam` → `all-in`, `bet` → `raise`).

### `agentWorker.ts`

The turn contract, in order: primary provider → retry (on the fallback
provider if one is configured) → fallback. The 30-second deadline covers the
whole turn; each attempt gets a smaller budget so one hung socket cannot eat
the clock. Failures are classified by what actually went wrong rather than by
clock arithmetic, so an attempt that aborted on its own budget reports as a
timeout even when the outer deadline is a millisecond away.

### `heuristic.ts`

The deterministic policy engine — the last-resort action, and the whole arena
when no API key is set. Monte Carlo equity (240 samples) against random
holdings, combined with pot odds and an aggression profile parsed out of the
manager's brief, so prompts still visibly matter offline. Raise thresholds
scale with how much of the stack is already at risk, which is what makes a
raising war terminate instead of shipping every stack on hand one.

---

## 3. Tables and rooms (`apps/server/src/rooms`)

`TableRunner` owns the autonomous loop: deal, ask each seat, apply, pay out,
rotate the button, repeat until the session's hands are done or fewer than two
seats have chips. It emits `FeedEvent`s as it goes; the WebSocket hub is a
subscriber, not a participant.

`RoomManager` holds the catalogue (every word budget in both formats), performs
batch deployment, and hands finished tables to settlement. Deployment validates
each table independently, so a brief that is legal in Tactical but three words
too long for Micro seats at one and is rejected at the other with a reason,
rather than failing the whole batch.

House agents fill short tables from a roster of six personas, each carrying a
micro-legal brief and a longer one; a table picks the longest brief that fits
its budget, so a Deep Strategy table faces genuinely different opposition from
a Micro table. They are attributed to `house` everywhere.

---

## 4. Settlement (`apps/server/src/chain`)

The off-chain ledger is released first: every manager's locked stake is
returned and their final stack credited, whatever the chain does next. Then
`EscrowClient.settle` reads the table's on-chain stake, caps payouts to it
(shaving from the largest stacks down), simulates, and sends
`settleTableMulti`. A failure is recorded on the settlement row rather than
silently claimed as success.

With no contract configured, `OfflineSettlement` records results locally and
the UI labels them "off chain" — never as a settled transaction.

---

## 5. The web app (`apps/web`)

- **Cashier** reads tier prices back from the contract before sending
  `buyChips`, then re-syncs the off-chain mirror only once the transaction
  confirms.
- **Strategy Lab** counts words with the same function the server enforces
  with, and shows which of the three rooms the current brief fits.
- **Lobby** groups tables by word budget, because that is the real axis of the
  game — a 10-word room and a 100-word room are different competitions.
- **Deploy panel** checks word budgets and total buy-in against bankroll before
  spending anything, and splits a batch into eligible and blocked.
- **Arena** renders the felt, the seats around an ellipse, the turn clock
  counting down to the 30-second deadline, trash talk as speech bubbles, and
  the inner monologue in its own feed tab.

`useArenaSocket` is read-only with exponential-backoff reconnect. State is
socket-first with an HTTP query as the fallback, so the page renders before the
socket connects and keeps working if it drops.

---

## Data flow for one turn

```
TableRunner.playHand
  └─ engine.currentActor()                → seat, legal actions
  └─ contextFromEngine()                  → Layer 1 state
  └─ AgentWorker.takeTurn(ctx, brief)
        ├─ Groq  ──▶ parseDecision  ─┐
        ├─ retry ──▶ parseDecision  ─┤
        └─ fallback ────────────────┴──▶ AgentDecision
  └─ engine.applyAction(decision)         → legalised PlayerAction
  └─ emit thought → action → chat         → WebSocket + store
```

Every step is observable: turn logs record the decision, its source and its
latency; hand histories record the board, the seed and the per-seat net.
