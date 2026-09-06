/**
 * Headless arena simulation.
 *
 * `npm run sim` deploys one persona across three tables of different word
 * limits and lets them play to completion with nothing connected — the exact
 * set-and-forget path a manager takes when they close the browser. It runs
 * with no API key (deterministic policy engine) and no chain, so it doubles
 * as the project's end-to-end smoke test.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHIP_TIERS, ROOM_MODE_BY_KEY, type FeedEvent } from '@agentholdem/shared';
import { OfflineSettlement } from './chain/escrow.js';
import { config } from './config.js';
import { Store } from './db/store.js';
import { AgentWorker } from './llm/agentWorker.js';
import { GeminiProvider, GroqProvider, type LlmProvider } from './llm/provider.js';
import { RoomManager } from './rooms/roomManager.js';
import { describeAction } from './rooms/table.js';

const MANAGER = '0x1111111111111111111111111111111111111111';

const PERSONA =
  'Play pot odds strictly. Fold marginal spots. Value bet relentlessly.';

async function main() {
  const verbose = process.argv.includes('--verbose');
  const store = new Store(mkdtempSync(join(tmpdir(), 'agentholdem-sim-')));

  const providers: LlmProvider[] = [];
  if (config.llm.groqApiKey) {
    providers.push(new GroqProvider(config.llm.groqApiKey, config.llm.groqModel));
  }
  if (config.llm.geminiApiKey) {
    providers.push(new GeminiProvider(config.llm.geminiApiKey, config.llm.geminiModel));
  }

  const worker = new AgentWorker({
    providers,
    turnTimeoutMs: config.llm.turnTimeoutMs,
    attemptTimeoutMs: config.llm.attemptTimeoutMs,
    useHeuristicFallback: true,
    log: verbose ? (l) => console.log(l) : undefined,
  });

  const rooms = new RoomManager({
    worker,
    store,
    settlement: new OfflineSettlement(),
    // Simulation pacing: no artificial delay, we want the whole session now.
    actionPaceMs: 0,
    handPauseMs: 0,
    turnTimeoutMs: config.llm.turnTimeoutMs,
    handsPerSession: 8,
    startDelayMs: 50,
    houseAgentsEnabled: true,
    log: verbose ? (l) => console.log(l) : undefined,
  });
  rooms.bootstrap();

  const starter = CHIP_TIERS[1]!;
  store.setBankroll(MANAGER, starter.chips);
  console.log(
    `Manager ${MANAGER} bought the ${starter.label} pack: ${starter.chips} chips ` +
      `for ${starter.priceTbnb} tBNB\n`,
  );

  // One persona, three rooms, one click. Then walk away.
  const targets = rooms
    .list()
    .filter((t) => t.config.buyInChips <= 250)
    .slice(0, 3);

  const deployment = rooms.deploy({
    owner: MANAGER,
    agentName: 'The Mathematician',
    prompt: PERSONA,
    tableIds: targets.map((t) => t.config.id),
  });

  console.log('Batch deploy:');
  for (const seat of deployment.seated) {
    const table = rooms.get(seat.tableId)!;
    console.log(
      `  seated at ${table.config.name} (${ROOM_MODE_BY_KEY[table.config.mode].wordLimit}-word ` +
        `${table.config.format}) for ${seat.buyInChips} chips`,
    );
  }
  for (const reject of deployment.rejected) {
    console.log(`  rejected ${reject.tableId}: ${reject.reason}`);
  }
  console.log(`  bankroll after deploy: ${deployment.bankrollAfter} chips\n`);

  if (deployment.seated.length === 0) {
    throw new Error('Nothing was seated — simulation cannot continue');
  }

  const watched = deployment.seated.map((s) => rooms.get(s.tableId)!);

  if (verbose) {
    for (const table of watched) {
      table.on('event', (event: FeedEvent) => {
        console.log(`  [${table.config.id}] ${renderEvent(event)}`);
      });
    }
  }

  const finished = watched.map(
    (table) =>
      new Promise<void>((resolve) => {
        table.on('event', (event: FeedEvent) => {
          if (event.kind === 'session-complete') resolve();
        });
      }),
  );

  const started = Date.now();
  for (const table of watched) rooms.forceStart(table.config.id);
  await Promise.all(finished);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\nAll ${watched.length} tables finished in ${elapsed}s.\n`);

  for (const table of watched) {
    console.log(`${table.config.name} — ${table.handNumber} hands`);
    for (const seat of [...table.seats].sort((a, b) => b.stack - a.stack)) {
      const net = seat.stack - seat.buyInChips;
      const tag = seat.owner === MANAGER ? ' ← your agent' : '';
      console.log(
        `  ${seat.agentName.padEnd(28)} ${String(seat.stack).padStart(6)} chips ` +
          `(${net >= 0 ? '+' : ''}${net})${tag}`,
      );
    }
    console.log();
  }

  const bankroll = store.bankroll(MANAGER);
  console.log(
    `Final bankroll: ${bankroll.available} chips available, ${bankroll.locked} locked ` +
      `(started with ${starter.chips}).`,
  );

  const turns = store.turnLogs(undefined, 5_000);
  const bySource = new Map<string, number>();
  for (const turn of turns) bySource.set(turn.source, (bySource.get(turn.source) ?? 0) + 1);
  console.log(`\n${turns.length} agent turns decided:`);
  for (const [source, count] of [...bySource].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${source.padEnd(22)} ${count}`);
  }

  const hands = store.handHistory(undefined, 500);
  console.log(`\n${hands.length} hands recorded with revealed shuffle seeds.`);

  rooms.shutdown();
  store.flush();
}

function renderEvent(event: FeedEvent): string {
  switch (event.kind) {
    case 'hand-start':
      return `--- hand #${event.handNumber} (button seat ${event.button}) ---`;
    case 'blinds':
      return `blinds: ${event.postings.map((p) => `${p.label} ${p.amount}`).join(', ')}`;
    case 'deal':
      return `${event.street}: ${event.board.join(' ') || '(hole cards dealt)'}`;
    case 'action':
      return `${event.agentName} ${describeAction(event.action)} [${event.source}] pot ${event.potAfter}`;
    case 'thought':
      return `  ${event.agentName} thinks: ${event.text}`;
    case 'chat':
      return `  ${event.agentName} says: "${event.text}"`;
    case 'showdown':
      return `showdown: ${event.reveals
        .map((r) => `seat ${r.seat} ${r.cards.join(' ')} (${r.rank?.label ?? '-'})`)
        .join(' | ')}`;
    case 'payout':
      return `payout: ${event.awards.map((a) => `${a.agentName} +${a.amount}`).join(', ')}`;
    case 'seat-bust':
      return `${event.agentName} is out of chips`;
    case 'session-complete':
      return `session complete: ${event.standings.map((s) => `${s.agentName} ${s.chips}`).join(', ')}`;
    default:
      return JSON.stringify(event);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
