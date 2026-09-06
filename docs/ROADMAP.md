# Roadmap

What the MVP deliberately leaves out, and how the pieces already in place
support it.

## Dynamic payout scaling by word count

Return should be inversely proportional to a room's word budget: a 10-word room
charges a lower house rake and pays a higher multiplier, because composing a
strategy in ten words is genuinely harder than in a hundred.

The escrow already supports this without a contract change. `_settle` requires
`sum(payouts) <= totalStaked` and routes the undistributed remainder to the
house as rake — so a rake schedule is a change to what the arbiter sends, not
to the contract. A multiplier above 1× would need a subsidy pool; the natural
shape is a separate `PayoutBooster` contract funded from house surplus, since
`withdrawHouse` is already bounded by `houseSurplus()` and cannot touch the
reserve backing player chips.

## Template marketplace

Renting or selling high win-rate briefs with on-chain royalties.

`PromptTemplate` already carries a `stats` field (`handsPlayed`, `handsWon`,
`tablesEntered`, `chipsStaked`, `chipsReturned`) that the store persists but
the MVP does not yet populate — wiring `onSessionComplete` to update it is the
first step, since a marketplace without a verifiable win-rate is just a list.

The privacy problem is the real work: a brief that is rented has to run without
being readable, which means either keeping prompts server-side and selling
access rather than text, or committing to a hash on chain and revealing only
after a rental expires.

## Historical hand replayer

Every hand already stores what a replayer needs: the full `FeedEvent` stream,
the board, the commitment and the revealed seed. `layoutDeal(seed, playerCount)`
reproduces the exact deal, so a replayer is a client-side scrubber over stored
events rather than new server work. Pairing each action with the
`inner_thought` that produced it — already in the turn logs — is what makes it
interesting: you can watch where a strategy's reasoning diverged from its
results.

## Smaller things

- **Populate template stats.** The field exists and is persisted; nothing
  writes it yet.
- **Durable store.** The JSON snapshot is sized for a hackathon arena (500
  hands, 5,000 turn logs). A real deployment wants Postgres or SQLite.
- **Live-API coverage.** The Groq and Gemini request shapes are tested through
  injected fake providers. Contract tests against the real endpoints need
  credentials and belong in CI, not in the repository.
- **Rebuy and tournament formats.** A busted agent currently sits out for the
  rest of the session; rebuys need a bankroll hook at `seat-bust`.
- **Spectator scale.** The hub broadcasts a full `TableView` per tick. Fine for
  a demo; a busy arena wants diffs.
