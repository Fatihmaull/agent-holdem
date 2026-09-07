'use client';

import { useState } from 'react';
import { formatChips, tableById } from '@/lib/economy';
import { PROMPT_BUDGETS, budgetLabel, countWords } from '@/lib/instructions';
import { useAccount } from './account-context';
import { ChipDot } from './table-art';
import { Badge, Button, ButtonLink, Card, Stat } from './ui';

const MAX_INSTRUCTIONS = 2000;

/**
 * Named by the idea each one demonstrates, so the button says what it will put
 * in the field rather than making you read three paragraphs to find out.
 */
const EXAMPLES = [
  {
    name: 'Raise your pairs',
    text: 'Raise three times the blind with any pair. Fold small suited cards from early seats.',
  },
  {
    name: 'Call down light',
    text: 'Call down light against anyone who bets every street. Give up when a quiet player raises the river.',
  },
  {
    name: 'Never punt',
    text: 'Never go all in without two pair or better. Bluff the river only when the flush missed.',
  },
];

/** A settings page. One field decides everything the agent does at every table. */
export function AgentEditor() {
  const { account, loading, signIn, connecting, refresh } = useAccount();
  // Null means "not edited yet", so the saved value shows without ever being
  // copied into state on render.
  const [draftName, setDraftName] = useState<string | null>(null);
  const [draftInstructions, setDraftInstructions] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (loading) {
    return (
      <Shell>
        <p className="py-20 text-center text-sm text-muted">Loading your agent…</p>
      </Shell>
    );
  }

  if (!account) {
    return (
      <Shell>
        <Card className="mx-auto mt-10 max-w-[46rem] p-8 text-center sm:p-12">
          <h1 className="mx-auto max-w-[24ch] text-2xl text-ink sm:text-3xl">
            One page of plain English decides every hand
          </h1>
          <p className="mx-auto mt-4 max-w-[54ch] text-base text-muted">
            Connect a wallet and this page becomes your agent&rsquo;s instructions. It is one signature, not a
            transaction, so it costs nothing. It proves the wallet is yours so nobody else can spend your chips.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button tone="primary" size="lg" onClick={() => void signIn()} disabled={connecting}>
              {connecting ? 'Check your wallet' : 'Connect wallet'}
            </Button>
            <ButtonLink href="/tables" size="lg">
              Watch a table first
            </ButtonLink>
          </div>
        </Card>
      </Shell>
    );
  }

  const { agent, seat } = account;
  const name = draftName ?? agent.name;
  const instructions = draftInstructions ?? agent.instructions;
  const dirty = name !== agent.name || instructions !== agent.instructions;
  const winRate = agent.handsPlayed > 0 ? `${Math.round((agent.handsWon / agent.handsPlayed) * 100)}%` : '—';

  async function save() {
    setSaving(true);
    setFailure(null);
    setStatus(null);
    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, instructions }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Could not save your changes.');
      await refresh();
      setDraftName(null);
      setDraftInstructions(null);
      setStatus('Saved. It takes effect on the next hand.');
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not save your changes.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="text-2xl text-ink sm:text-3xl">Your agent</h1>
          <p className="mt-1.5 text-sm text-muted">
            Everything below applies at every table, on the next hand after you save.
          </p>
        </div>
        {seat ? (
          <ButtonLink href={`/table/${seat.tableId}`}>Watch it play</ButtonLink>
        ) : (
          <ButtonLink tone="primary" href="/tables">
            Find a table
          </ButtonLink>
        )}
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-5">
          <Card className="p-5">
            <label htmlFor="agent-name" className="block text-sm font-medium text-ink">
              Name
            </label>
            <p className="mt-1 text-xs text-faint">Shown at the table and in the hand log. Up to 24 characters.</p>
            <div className="mt-3 flex items-center gap-3">
              <ChipDot color={agent.color} size={22} />
              <input
                id="agent-name"
                value={name}
                onChange={(event) => setDraftName(event.target.value)}
                maxLength={24}
                className="h-10 w-full max-w-[22rem] rounded-control border border-line-input bg-surface-2 px-3 text-sm text-ink outline-none focus:border-accent"
              />
            </div>
          </Card>

          <Card className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
              <div>
                <label htmlFor="instructions" className="block text-sm font-medium text-ink">
                  How it should play
                </label>
                <p className="mt-1 max-w-[58ch] text-xs text-faint">
                  Write it the way you would tell a person: which hands to raise, how much to bet, when to bluff
                  and when to give up. The engine still checks every action against the legal moves, so nothing
                  written here can make an illegal bet.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-faint">Start from</span>
                {EXAMPLES.map((example) => (
                  <Button key={example.name} size="sm" onClick={() => setDraftInstructions(example.text)}>
                    {example.name}
                  </Button>
                ))}
              </div>
            </div>

            <textarea
              id="instructions"
              value={instructions}
              onChange={(event) => setDraftInstructions(event.target.value.slice(0, MAX_INSTRUCTIONS))}
              spellCheck
              rows={14}
              placeholder="Raise three times the blind with any pair. Fold small suited cards from early seats."
              className="mt-4 w-full resize-y rounded-control border border-line-input bg-surface-2 px-4 py-3 text-sm leading-relaxed text-ink outline-none placeholder:text-faint focus:border-accent"
            />

            <BudgetMeter instructions={instructions} seatedAt={seat?.tableId ?? null} />

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="mono text-xs text-faint tabular-nums">
                {instructions.length} / {MAX_INSTRUCTIONS} characters
              </span>
              {status ? <span className="text-xs text-accent">{status}</span> : null}
              {failure ? <span className="text-xs text-danger">{failure}</span> : null}
              <Button
                tone="primary"
                className="ml-auto"
                onClick={() => void save()}
                disabled={saving || !dirty}
              >
                {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
              </Button>
            </div>
          </Card>
        </div>

        <aside className="space-y-5">
          <Card className="p-5">
            <h2 className="text-base text-ink">Where it is</h2>
            <div className="mt-3">
              {seat ? (
                <>
                  <Badge tone="accent">Seated</Badge>
                  <p className="mt-3 text-sm text-muted">
                    Playing with {formatChips(seat.stack)} chips in front of it.
                  </p>
                  <ButtonLink href={`/table/${seat.tableId}`} className="mt-3 w-full">
                    Open the table
                  </ButtonLink>
                </>
              ) : (
                <>
                  <Badge>Not seated</Badge>
                  <p className="mt-3 text-sm text-muted">
                    It plays nothing until you put it at a table. It can hold one seat at a time.
                  </p>
                  <ButtonLink tone="primary" href="/tables" className="mt-3 w-full">
                    Browse tables
                  </ButtonLink>
                </>
              )}
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="text-base text-ink">Record</h2>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-5">
              <Stat label="Hands" value={agent.handsPlayed.toLocaleString('en-US')} />
              <Stat label="Won" value={winRate} />
              <Stat label="Net chips" value={`${agent.chipsWon >= 0 ? '+' : ''}${formatChips(agent.chipsWon)}`} />
              <Stat label="Biggest pot" value={formatChips(agent.biggestPot)} />
            </dl>
          </Card>
        </aside>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="page mx-auto w-full max-w-[76rem] px-4 py-8 sm:px-6 sm:py-10">{children}</div>;
}

/**
 * What the writing costs, in the unit that decides where it can sit.
 *
 * A table's word budget is the constraint the table is about, so the counter
 * is not a character limit dressed up: it shows which rooms the text can
 * currently enter, and while the agent is seated it shows the one budget that
 * is actually binding.
 */
function BudgetMeter({ instructions, seatedAt }: { instructions: string; seatedAt: string | null }) {
  const words = countWords(instructions);
  const seatedBudget = seatedAt ? (tableById(seatedAt)?.wordLimit ?? null) : null;

  if (seatedBudget !== null) {
    const over = words - seatedBudget;
    return (
      <div className="mt-3 rounded-control border border-line bg-surface-2 px-3 py-2">
        <p className="text-xs text-muted">
          Seated at a{' '}
          <span className="text-ink">
            {seatedBudget}-word {budgetLabel(seatedBudget)}
          </span>{' '}
          table.{' '}
          <span className={over > 0 ? 'text-danger' : 'text-muted'}>
            {words} / {seatedBudget} words
            {over > 0 ? ` — ${over} over, so this will not save` : ''}
          </span>
        </p>
        {over > 0 ? (
          <p className="mt-1 text-xs text-faint">
            Cut it back, or take the agent off the table to write at full length.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="mono text-xs text-muted tabular-nums">{words} words</span>
      <span className="text-xs text-faint">fits</span>
      {PROMPT_BUDGETS.map((budget) => {
        const ok = words <= budget;
        return (
          <span
            key={budget}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
              ok ? 'border-accent/35 bg-accent-soft text-accent' : 'border-line bg-surface-2 text-faint'
            }`}
            title={
              ok
                ? `Can take a seat at ${budget}-word tables`
                : `${words - budget} words too many for ${budget}-word tables`
            }
          >
            {ok ? '✓' : '·'} {budget} {budgetLabel(budget)}
          </span>
        );
      })}
    </div>
  );
}
