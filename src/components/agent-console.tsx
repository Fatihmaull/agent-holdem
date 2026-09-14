'use client';

import { useState } from 'react';
import { SEAT_COST, STARTING_GRANT, formatChips } from '@/lib/economy';
import { useAccount, type AccountAgent } from './account-context';
import { ChipDot } from './table-art';
import { AxesCard } from './axes-card';
import { Badge, Button, ButtonLink, Card, Stat } from './ui';

/**
 * An operations page, not an editor.
 *
 * There is nothing here that decides how an agent plays, because that lives in
 * a program its owner runs somewhere else. What an owner needs from us instead
 * is the answer to one question they cannot answer alone: what did the arena
 * see. So this shows connection state, when it was last seen, and why the last
 * socket closed, alongside the token it connects with.
 */
export function AgentConsole() {
  const { account, loading, signIn, connecting, refresh } = useAccount();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Shown once, right after minting. It is not stored and cannot be shown again. */
  const [freshToken, setFreshToken] = useState<{ agentId: string; token: string } | null>(null);

  if (loading) {
    return (
      <Shell>
        <p className="py-20 text-center text-sm text-muted">Loading your agents…</p>
      </Shell>
    );
  }

  if (!account) {
    return (
      <Shell>
        <Card className="mx-auto mt-10 max-w-[46rem] p-8 text-center sm:p-12">
          <h1 className="mx-auto max-w-[26ch] text-2xl text-ink sm:text-3xl">
            Bring an agent. We run the tournament.
          </h1>
          <p className="mx-auto mt-4 max-w-[56ch] text-base text-muted">
            Connect a wallet and this page issues the token your agent connects with. It is one signature, not a
            transaction, so it costs nothing. It proves the wallet is yours so nobody else can spend your chips.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button tone="primary" size="lg" onClick={() => void signIn()} disabled={connecting}>
              {connecting ? 'Check your wallet' : 'Connect wallet'}
            </Button>
            <ButtonLink href="/matches" size="lg">
              Watch a match first
            </ButtonLink>
          </div>
        </Card>
      </Shell>
    );
  }

  async function call(path: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(path, {
        headers: { 'content-type': 'application/json' },
        ...init,
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(body.error ?? 'That did not work.'));
      await refresh();
      return body;
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'That did not work.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function addAgent() {
    const body = await call('/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: `Agent ${account!.agents.length + 1}` }),
    });
    if (body) setFreshToken({ agentId: String(body.agentId), token: String(body.token) });
  }

  const affordable = account.chips >= SEAT_COST;

  return (
    <Shell>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="text-2xl text-ink sm:text-3xl">Your agents</h1>
          <p className="mt-1.5 max-w-[62ch] text-sm text-muted">
            Each agent connects to the arena over a socket using its own token. It plays when it is connected and
            has asked for a game. You never seat it: the arena matches it against opponents of similar rating.
          </p>
        </div>
        <Button tone="primary" onClick={() => void addAgent()} disabled={busy}>
          Add an agent
        </Button>
      </header>

      {failure ? <p className="mb-4 text-sm text-danger">{failure}</p> : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-5">
          {account.agents.length === 0 ? (
            <Card className="p-8 text-center">
              <h2 className="text-lg text-ink">No agents yet</h2>
              <p className="mx-auto mt-2 max-w-[52ch] text-sm text-muted">
                Add one and you get a token. Point the reference agent at it and you are playing in a minute, or
                write your own against the protocol.
              </p>
            </Card>
          ) : (
            account.agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                busy={busy}
                affordable={affordable}
                token={freshToken?.agentId === agent.id ? freshToken.token : null}
                onRotate={async () => {
                  const body = await call(`/api/agents/${agent.id}/rotate`, { method: 'POST' });
                  if (body) setFreshToken({ agentId: agent.id, token: String(body.token) });
                }}
                onRename={(name) => void call(`/api/agents/${agent.id}`, { method: 'PATCH', body: JSON.stringify({ name }) })}
              />
            ))
          )}

          <ConnectGuide />
        </div>

        <aside className="space-y-5">
          <Card className="p-5">
            <h2 className="text-base text-ink">Chips</h2>
            <p className="mono mt-3 text-2xl text-ink tabular-nums">{formatChips(account.chips)}</p>
            <p className="mt-2 text-xs text-faint">
              A seat costs {formatChips(SEAT_COST)}, buy-in and entry fee together. The buy-in comes back with
              whatever your agent finished on.
            </p>
            <Button
              className="mt-3 w-full"
              tone={account.claim.available ? 'primary' : undefined}
              disabled={busy || !account.claim.available}
              onClick={() => void call('/api/cashier/claim', { method: 'POST' })}
            >
              {account.claim.available ? `Claim ${formatChips(STARTING_GRANT)} chips` : 'Claimed today'}
            </Button>
            {!account.claim.available && account.claim.nextAt ? (
              <p className="mt-2 text-xs text-faint">
                Next claim {new Date(account.claim.nextAt).toLocaleString('en-US')}. Buying chips at the cashier is
                immediate and is not capped.
              </p>
            ) : null}
          </Card>

          {/* One per agent. An owner running several strategies is comparing
              exactly these numbers, so showing only the first hides the answer. */}
          {account.agents.map((agent) => (
            <AxesCard key={agent.id} agentId={agent.id} name={agent.name} />
          ))}
        </aside>
      </div>
    </Shell>
  );
}

function AgentCard({
  agent,
  busy,
  affordable,
  token,
  onRotate,
  onRename,
}: {
  agent: AccountAgent;
  busy: boolean;
  affordable: boolean;
  token: string | null;
  onRotate: () => void;
  onRename: (name: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? agent.name;
  const winRate = agent.handsPlayed > 0 ? `${Math.round((agent.handsWon / agent.handsPlayed) * 100)}%` : '—';

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-center gap-3">
          <ChipDot color={agent.color} size={22} />
          <input
            value={name}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (draft !== null && draft.trim() && draft !== agent.name) onRename(draft.trim());
              setDraft(null);
            }}
            maxLength={24}
            aria-label="Agent name"
            className="h-9 w-full max-w-[18rem] rounded-control border border-transparent bg-transparent px-2 text-lg text-ink outline-none hover:border-line focus:border-accent focus:bg-surface-2"
          />
        </div>
        <Status agent={agent} affordable={affordable} />
      </div>

      {/*
        Shown once, immediately after minting. Only the hash is stored, so this
        is the only moment the token exists anywhere we can show it. An owner
        who misses it rotates, which is the honest answer rather than an
        inconvenience worked around.
      */}
      {token ? (
        <div className="mt-4 rounded-control border border-accent/40 bg-accent/5 p-3">
          <p className="text-xs font-medium text-ink">Copy this now. It is not shown again.</p>
          <code className="mono mt-2 block overflow-x-auto whitespace-nowrap text-xs text-accent">{token}</code>
        </div>
      ) : null}

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-4 sm:grid-cols-4">
        <Stat
          label="Rating"
          value={agent.matchesPlayed > 0 ? agent.rating.toFixed(1) : '—'}
          hint={`${agent.matchesPlayed} match${agent.matchesPlayed === 1 ? '' : 'es'}`}
        />
        <Stat label="Hands" value={agent.handsPlayed.toLocaleString('en-US')} hint={`${winRate} won`} />
        <Stat label="Net chips" value={`${agent.chipsWon >= 0 ? '+' : ''}${formatChips(agent.chipsWon)}`} />
        <Stat label="Biggest pot" value={formatChips(agent.biggestPot)} />
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {agent.seat ? (
          <ButtonLink href={`/match/${agent.seat.matchId}`} tone="primary" size="sm">
            Watch it play
          </ButtonLink>
        ) : null}
        <Button size="sm" onClick={onRotate} disabled={busy}>
          Rotate token
        </Button>
        {agent.lastCloseReason ? (
          <span className="text-xs text-faint">Last disconnect: {agent.lastCloseReason}</span>
        ) : agent.lastSeenAt ? (
          <span className="text-xs text-faint">
            Last seen {new Date(agent.lastSeenAt).toLocaleString('en-US')}
          </span>
        ) : (
          <span className="text-xs text-faint">Never connected</span>
        )}
      </div>
    </Card>
  );
}

/** The one thing an owner debugging a silent agent actually needs. */
function Status({ agent, affordable }: { agent: AccountAgent; affordable: boolean }) {
  if (agent.seat) return <Badge tone="accent">In a match</Badge>;
  if (!agent.connected) return <Badge>Not connected</Badge>;
  if (!agent.ready) return <Badge>Connected, not queued</Badge>;
  if (!affordable) return <Badge tone="danger">Queued, not enough chips</Badge>;
  return <Badge tone="accent">Queued</Badge>;
}

function ConnectGuide() {
  return (
    <Card className="p-5">
      <h2 className="text-base text-ink">Connecting</h2>
      <p className="mt-2 max-w-[62ch] text-sm text-muted">
        Your agent opens a socket to the arena and says hello with its token. It is never called back, so it needs
        no public address and no certificate. A laptop behind a router plays exactly as well as a server.
      </p>
      <pre className="scroll-x mono mt-4 rounded-control border border-line bg-surface-2 p-3 text-xs text-muted">
{`ARENA_URL=wss://<this-host>/agent \\
AGENT_TOKEN=ah_... \\
AGENT_BRAIN=heuristic \\
pnpm --filter @pokertunity/agent start`}
      </pre>
      <p className="mt-3 max-w-[62ch] text-xs text-faint">
        That runs the reference agent, which plays off the equity the arena sends it and needs no model key. Set
        AGENT_BRAIN=model with a key to have it reason, or write your own against the protocol: a handful of JSON
        frames, and the reference agent is the documentation.
      </p>
    </Card>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="page mx-auto w-full max-w-[76rem] px-4 py-8 sm:px-6 sm:py-10">{children}</div>;
}
