import { MAX_SEATS, MIN_SEATS } from '../lib/economy';
import { closeMatch, openMatch } from './registry';
import {
  createMatch,
  liveMatchIds,
  queuedAgents,
  settleMatch,
  topUpLapsedAccounts,
  type Candidate,
  type MatchEnding,
} from './store';

/**
 * Who plays whom.
 *
 * Agents no longer pick their game. They queue, and this puts them into a match
 * against opponents of similar rating. That change is the point rather than a
 * convenience: when an agent chooses its own table it will choose the softest
 * one available, which is the single most profitable thing a poker player can
 * do and has nothing to do with playing a hand well. Measuring how an agent
 * thinks means not paying it to avoid thinking.
 *
 * Matching by rating has one consequence worth being honest about. If it works
 * perfectly, everyone faces opponents of their own strength and every win rate
 * converges on nothing. That is why the standings rank on the rating rather
 * than on chips won, and why the bands here are deliberately loose rather than
 * tight.
 */

/** How often the queue is looked at. Frequent enough to feel immediate, cheap enough to ignore. */
const TICK_MS = 5_000;

/**
 * How long a full table is worth waiting for.
 *
 * Six-handed is the better game, so a queue that is one short is given a minute
 * to fill before settling for what it has. Beyond that an empty arena is worse
 * than a short match.
 */
const FULL_TABLE_WAIT_MS = 60_000;

/**
 * How far apart two agents can be rated and still be seated together.
 *
 * Loose on purpose. A tight band would sort a small field into matches of two
 * and, at scale, would flatten every result to a coin flip. This is meant to
 * keep the strongest away from the weakest, not to manufacture dead heats.
 */
const BAND_START = 6;

/** How much the band opens up for every minute somebody has been waiting. */
const BAND_GROWTH_PER_MINUTE = 6;

/** Lapsed accounts are topped back up once a day, not once a tick. */
const TOP_UP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const globalForFloor = globalThis as unknown as {
  __agentholdemFloor?: { timer: NodeJS.Timeout | null; lastTopUp: number };
};

function floor(): { timer: NodeJS.Timeout | null; lastTopUp: number } {
  if (!globalForFloor.__agentholdemFloor) globalForFloor.__agentholdemFloor = { timer: null, lastTopUp: 0 };
  return globalForFloor.__agentholdemFloor;
}

export function startMatchmaker(): void {
  const state = floor();
  if (state.timer) return;

  state.timer = setInterval(() => {
    void tick().catch((error) => console.error('[matchmaker] tick failed', error));
  }, TICK_MS);

  void tick().catch((error) => console.error('[matchmaker] first tick failed', error));
}

export function stopMatchmaker(): void {
  const state = floor();
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/**
 * Returns every match that was being dealt when the last process went away.
 *
 * Stacks go back to their owners and nobody is rated. A match the server walked
 * out of says nothing about how well anyone played, and resuming one would mean
 * storing and replaying its whole state for a case that should be rare.
 */
export async function abandonOrphanedMatches(): Promise<number> {
  const orphaned = await liveMatchIds();

  for (const matchId of orphaned) {
    try {
      await settleMatch(matchId, 'abandoned', 0);
    } catch (error) {
      console.error(`[matchmaker] could not abandon ${matchId}`, error);
    }
  }

  return orphaned.length;
}

async function tick(): Promise<void> {
  const state = floor();
  if (Date.now() - state.lastTopUp > TOP_UP_INTERVAL_MS) {
    state.lastTopUp = Date.now();
    const topped = await topUpLapsedAccounts();
    if (topped > 0) console.log(`[matchmaker] topped up ${topped} account${topped === 1 ? '' : 's'}`);
  }

  const waiting = await queuedAgents();
  if (waiting.length < MIN_SEATS) return;

  for (const group of groupsFrom(waiting)) {
    const match = await createMatch(group);
    if (!match) continue;

    console.log(`[matchmaker] opened ${match.id} with ${group.map((entrant) => entrant.name).join(', ')}`);
    openMatch(match.id, match.config, onFinished);
  }
}

/**
 * Splits the queue into the matches that should start right now.
 *
 * Whoever has waited longest anchors a table, and the band is drawn around
 * them, so a lonely agent at the edge of the field gets a wider net rather than
 * waiting forever for a neighbour who never arrives. A group that is not yet
 * full and has not waited long enough is left in the queue to try again.
 */
function groupsFrom(waiting: readonly Candidate[], now = Date.now()): Candidate[][] {
  // Longest wait first: the queue is already in that order, and rebuilding it
  // by rating would quietly prioritise whoever happened to rate highest.
  const pool = [...waiting];
  const groups: Candidate[][] = [];

  while (pool.length >= MIN_SEATS) {
    const anchor = pool.shift()!;
    const waited = now - anchor.waitingSince.getTime();
    const band = BAND_START + (waited / 60_000) * BAND_GROWTH_PER_MINUTE;

    const group = [anchor];
    const owners = new Set([anchor.ownerId]);

    for (const candidate of [...pool]) {
      if (group.length >= MAX_SEATS) break;
      if (Math.abs(candidate.published - anchor.published) > band) continue;
      // One owner, one seat. Two agents with the same owner at one table would
      // be a pair without ever agreeing anything: the owner sees both sets of
      // cards, and one can fold every pot the other contests until the chips
      // have moved to whichever account they want them in.
      if (owners.has(candidate.ownerId)) continue;

      group.push(candidate);
      owners.add(candidate.ownerId);
      pool.splice(pool.indexOf(candidate), 1);
    }

    // A short table is a real game and a full one is a better game, so a group
    // that could still fill up is put back rather than started early.
    if (group.length < MAX_SEATS && waited < FULL_TABLE_WAIT_MS) {
      pool.unshift(...group);
      break;
    }

    if (group.length < MIN_SEATS) {
      pool.unshift(...group.slice(1));
      continue;
    }

    groups.push(group);
  }

  return groups;
}

/**
 * Closes out a match the moment its runtime says it is done.
 *
 * Settling is deliberately not the runtime's job. It returns chips and rewrites
 * ratings, and none of that belongs tangled up with the loop that deals cards.
 */
function onFinished(matchId: string, ending: MatchEnding, hands: number): void {
  void (async () => {
    try {
      const finishes = await settleMatch(matchId, ending, hands);

      for (const finish of finishes.sort((a, b) => a.place - b.place)) {
        const moved = finish.after.mu - finish.before.mu;
        console.log(
          `[matchmaker] ${matchId} #${finish.place} ${finish.name} ` +
            `stack ${finish.finalStack} rating ${finish.after.mu.toFixed(1)} (${moved >= 0 ? '+' : ''}${moved.toFixed(1)})`,
        );
      }
    } catch (error) {
      console.error(`[matchmaker] could not settle ${matchId}`, error);
    } finally {
      closeMatch(matchId);
    }
  })();
}
