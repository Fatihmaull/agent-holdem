'use client';

import { useCallback, useEffect, useState } from 'react';
import { TABLES, formatChips, tableById, tableLabel } from '@/lib/economy';
import { PROMPT_BUDGETS, budgetLabel, countWords } from '@/lib/instructions';
import { useAccount } from './account-context';
import type { AccountAgent } from './account-context';
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string | null>(null);
  const [draftInstructions, setDraftInstructions] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const drafts = useDrafts();

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

  // The selection is held by id rather than by object, so a poll that replaces
  // the account does not snap the editor back to the first agent mid-sentence.
  const agent = account.agents.find((row) => row.id === selectedId) ?? account.agents[0];
  if (!agent) return <Shell><p className="py-20 text-center text-sm text-muted">No agent yet.</p></Shell>;

  const seat = agent.seat;
  const name = draftName ?? agent.name;
  const instructions = draftInstructions ?? agent.instructions;
  const dirty = name !== agent.name || instructions !== agent.instructions;
  const winRate = agent.handsPlayed > 0 ? `${Math.round((agent.handsWon / agent.handsPlayed) * 100)}%` : '—';

  function select(id: string) {
    setSelectedId(id);
    setDraftName(null);
    setDraftInstructions(null);
    setStatus(null);
    setFailure(null);
  }

  async function save() {
    setSaving(true);
    setFailure(null);
    setStatus(null);
    try {
      const response = await fetch(`/api/agent/${agent.id}`, {
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
          <h1 className="text-2xl text-ink sm:text-3xl">
            {account.agents.length > 1 ? 'Your agents' : 'Your agent'}
          </h1>
          <p className="mt-1.5 text-sm text-muted">
            Each agent holds one seat and one stack. Editing one takes effect on its next hand.
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

      <AgentRoster
        agents={account.agents}
        selectedId={agent.id}
        onSelect={select}
        onChanged={() => void refresh()}
      />

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

            <DraftShelf
              drafts={drafts}
              current={instructions}
              onLoad={(body) => {
                setDraftInstructions(body);
                setStatus('Loaded into the editor. Save to make it live.');
                setFailure(null);
              }}
            />

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
          <DeployPanel
            instructions={instructions}
            chips={account.chips}
            occupied={
              new Set(
                account.agents
                  .map((row) => row.seat?.tableId)
                  .filter((id): id is string => Boolean(id)),
              )
            }
            onDeployed={() => void refresh()}
          />
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
                    It plays nothing until you put it at a table. Each agent holds one seat at a
                    time; add another agent to play a second table.
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

interface Draft {
  id: string;
  name: string;
  body: string;
  updatedAt: string;
}

interface Drafts {
  list: Draft[];
  loading: boolean;
  error: string | null;
  save: (name: string, body: string) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
}

/**
 * Loads the account's saved drafts and keeps the list in step with writes.
 *
 * The list is external state, so it is fetched and applied in a callback
 * rather than assigned while the effect body runs, the same way the lobby
 * roster is polled.
 */
function useDrafts(): Drafts {
  const [list, setList] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  const reload = useCallback(() => setReloads((count) => count + 1), []);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/templates', { cache: 'no-store' })
      .then((response) => (response.ok ? (response.json() as Promise<{ templates?: Draft[] }>) : null))
      .then((body) => {
        if (cancelled) return;
        setList(body?.templates ?? []);
        setLoading(false);
      })
      .catch(() => {
        // A shelf that fails to load is not worth an error banner over the
        // editor; the field itself still works.
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [reloads]);

  const save = useCallback(
    async (name: string, body: string) => {
      setError(null);
      const response = await fetch('/api/templates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, body }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(payload.error ?? 'Could not save that draft.');
        return false;
      }
      reload();
      return true;
    },
    [reload],
  );

  const remove = useCallback(
    async (id: string) => {
      setError(null);
      const response = await fetch(`/api/templates/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? 'Could not delete that draft.');
        return;
      }
      reload();
    },
    [reload],
  );

  return { list, loading, error, save, remove };
}

/**
 * Somewhere to keep more than one way of playing.
 *
 * Loading a draft fills the editor and stops there — it does not change how the
 * agent is playing until the owner saves, which keeps one click from silently
 * altering a seat that is mid-session.
 */
function DraftShelf({
  drafts,
  current,
  onLoad,
}: {
  drafts: Drafts;
  current: string;
  onLoad: (body: string) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function commit() {
    if (!name.trim()) return;
    setBusy(true);
    const saved = await drafts.save(name, current);
    setBusy(false);
    if (saved) {
      setName('');
      setNaming(false);
    }
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div>
          <h3 className="text-sm font-medium text-ink">Saved drafts</h3>
          <p className="mt-0.5 text-xs text-faint">
            Keep a short brief for the ten-word tables and a long one for the hundreds. Loading a draft only fills
            the box above; nothing changes until you save.
          </p>
        </div>
        {naming ? (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void commit();
                if (event.key === 'Escape') setNaming(false);
              }}
              maxLength={40}
              placeholder="Name this draft"
              className="h-8 w-48 rounded-control border border-line-input bg-surface-2 px-2.5 text-sm text-ink outline-none focus:border-accent"
            />
            <Button size="sm" tone="primary" onClick={() => void commit()} disabled={busy || !name.trim()}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" onClick={() => setNaming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button size="sm" onClick={() => setNaming(true)} disabled={!current.trim()}>
            Save this as a draft
          </Button>
        )}
      </div>

      {drafts.error ? <p className="mt-2 text-xs text-danger">{drafts.error}</p> : null}

      {drafts.loading ? null : drafts.list.length === 0 ? (
        <p className="mt-3 text-xs text-faint">No drafts yet.</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {drafts.list.map((draft) => (
            <li
              key={draft.id}
              className="flex items-center gap-3 rounded-control border border-line bg-surface-2 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">{draft.name}</p>
                <p className="truncate text-xs text-faint">
                  {countWords(draft.body)} words · {draft.body || 'empty'}
                </p>
              </div>
              <Button size="sm" onClick={() => onLoad(draft.body)}>
                Load
              </Button>
              <Button size="sm" onClick={() => void drafts.remove(draft.id)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The account's agents, and the way to add or retire one.
 *
 * They are shown by colour first because colour is what identifies an agent
 * everywhere else in the interface — at the table, in the hand log, on the
 * lobby row — so the roster reads the same way the felt does.
 */
function AgentRoster({
  agents,
  selectedId,
  onSelect,
  onChanged,
}: {
  agents: AccountAgent[];
  selectedId: string;
  onSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setFailure(null);
    const response = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Agent ${agents.length + 1}` }),
    });
    const body = (await response.json()) as { id?: string; error?: string };
    setBusy(false);
    if (!response.ok) {
      setFailure(body.error ?? 'Could not add an agent.');
      return;
    }
    onChanged();
    if (body.id) onSelect(body.id);
  }

  async function retire(id: string) {
    setBusy(true);
    setFailure(null);
    const response = await fetch(`/api/agent/${id}`, { method: 'DELETE' });
    setBusy(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setFailure(body.error ?? 'Could not retire that agent.');
      return;
    }
    onChanged();
  }

  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-center gap-2">
        {agents.map((agent) => {
          const active = agent.id === selectedId;
          return (
            <button
              key={agent.id}
              type="button"
              onClick={() => onSelect(agent.id)}
              className={`flex items-center gap-2 rounded-control border px-3 py-2 text-sm transition-colors ${
                active
                  ? 'border-accent bg-accent-soft text-ink'
                  : 'border-line bg-surface-2 text-muted hover:border-line-strong'
              }`}
            >
              <ChipDot color={agent.color} size={16} />
              <span className="max-w-[10rem] truncate">{agent.name}</span>
              {agent.seat ? <Badge tone="accent">Seated</Badge> : null}
            </button>
          );
        })}

        <Button size="sm" onClick={() => void add()} disabled={busy}>
          Add an agent
        </Button>

        {agents.length > 1 ? (
          <Button size="sm" onClick={() => void retire(selectedId)} disabled={busy}>
            Retire this one
          </Button>
        ) : null}
      </div>
      {failure ? <p className="mt-2 text-xs text-danger">{failure}</p> : null}
    </div>
  );
}

/**
 * One piece of writing, several tables, one click.
 *
 * Each table gets its own agent because an agent holds one seat and one
 * undivided stack. They share the text; they do not share chips or a record.
 * Tables the current writing is too long for are shown as such rather than
 * silently left out of the list.
 */
function DeployPanel({
  instructions,
  chips,
  occupied,
  onDeployed,
}: {
  instructions: string;
  chips: number;
  /** Tables this account already has an agent at; one seat per table each. */
  occupied: Set<string>;
  onDeployed: () => void;
}) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const words = countWords(instructions);
  const eligible = TABLES.filter(
    (table) => !occupied.has(table.id) && words <= table.wordLimit,
  );
  const cost = TABLES.filter((table) => picked.includes(table.id)).reduce(
    (total, table) => total + table.buyIn,
    0,
  );

  async function deploy() {
    setBusy(true);
    setFailure(null);
    setResult(null);
    const response = await fetch('/api/deploy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.trim() || 'Agent', instructions, tableIds: picked }),
    });
    const body = (await response.json()) as {
      seated?: { tableId: string }[];
      skipped?: { tableId: string; reason: string }[];
      error?: string;
    };
    setBusy(false);
    if (!response.ok) {
      setFailure(body.error ?? 'Could not deploy.');
      return;
    }
    setPicked([]);
    onDeployed();
    const seated = body.seated?.length ?? 0;
    const skipped = body.skipped ?? [];
    setResult(
      `Seated at ${seated} table${seated === 1 ? '' : 's'}.` +
        (skipped.length ? ` ${skipped.length} skipped: ${skipped[0]?.reason}` : ''),
    );
  }

  return (
    <Card className="p-5">
      <h2 className="text-base text-ink">Deploy this writing to several tables</h2>
      <p className="mt-1 max-w-[62ch] text-xs text-faint">
        Each table gets its own agent with its own stack and its own record. They start from the same
        instructions and diverge from there. You can close the tab once they are seated.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={20}
          placeholder="Name them"
          className="h-9 w-44 rounded-control border border-line-input bg-surface-2 px-2.5 text-sm text-ink outline-none focus:border-accent"
        />
        <span className="text-xs text-faint">
          each one takes the number of the table it sits at, so the 4-Max 10/20 seat becomes “
          {(name.trim() || 'Agent')} 3”
        </span>
      </div>

      {eligible.length === 0 ? (
        <p className="mt-4 text-xs text-faint">
          {words === 0
            ? 'Write something above first.'
            : `No table is free and long enough for ${words} words right now.`}
        </p>
      ) : (
        <ul className="mt-4 space-y-1.5">
          {eligible.map((table) => {
            const on = picked.includes(table.id);
            return (
              <li key={table.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-control border border-line bg-surface-2 px-3 py-2">
                  <input
                    type="checkbox"
                    className="checkbox-field"
                    checked={on}
                    onChange={() =>
                      setPicked((current) =>
                        current.includes(table.id)
                          ? current.filter((id) => id !== table.id)
                          : [...current, table.id],
                      )
                    }
                  />
                  <span className="flex-1 text-sm text-ink">{tableLabel(table)}</span>
                  <span className="mono text-xs text-faint tabular-nums">
                    {table.wordLimit}w · {formatChips(table.buyIn)}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span className="mono text-xs text-faint tabular-nums">
          {formatChips(cost)} of {formatChips(chips)} chips
        </span>
        <Button
          tone="primary"
          className="ml-auto"
          disabled={busy || picked.length === 0 || cost > chips}
          onClick={() => void deploy()}
        >
          {busy ? 'Deploying…' : `Deploy to ${picked.length || ''} ${picked.length === 1 ? 'table' : 'tables'}`}
        </Button>
      </div>

      {cost > chips ? (
        <p className="mt-2 text-xs text-danger">
          That is {formatChips(cost - chips)} more than you have. Visit the cashier.
        </p>
      ) : null}
      {failure ? <p className="mt-2 text-xs text-danger">{failure}</p> : null}
      {result ? <p className="mt-2 text-xs text-accent">{result}</p> : null}
    </Card>
  );
}
