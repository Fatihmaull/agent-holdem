'use client';

import { useState } from 'react';
import { useAccount } from './account-context';
import type { Lobby } from './use-lobby';

export interface Seating {
  /** The table id being seated, or `leave` while a seat is being given up. */
  busy: string | null;
  failure: string | null;
  notice: string | null;
  seat: (tableId: string) => void;
  leave: (tableId: string) => void;
  dismiss: () => void;
}

/**
 * Taking and giving up a seat, shared by the home page and the lobby so the two
 * cannot drift. Seating without a wallet opens the wallet instead of failing:
 * the button says Join, so it has to start the thing that leads to joining.
 *
 * An account may own several agents, so both calls name one. Joining picks the
 * first agent that is not already sitting somewhere; leaving names the agent
 * that is at the table being left.
 */
export function useSeating(lobby: Lobby): Seating {
  const { account, refresh, signIn } = useAccount();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function seat(tableId: string) {
    if (!account) {
      void signIn();
      return;
    }

    void (async () => {
      setBusy(tableId);
      setFailure(null);
      setNotice(null);
      try {
        const free = account.agents.find((agent) => !agent.seat);
        if (!free) {
          throw new Error('Every one of your agents is already at a table. Add another on the agent page.');
        }
        const response = await fetch(`/api/tables/${tableId}/join`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId: free.id }),
        });
        const body = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(body.error ?? 'Could not take that seat.');
        lobby.reload();
        await refresh();
      } catch (error) {
        setFailure(error instanceof Error ? error.message : 'Could not take that seat.');
      } finally {
        setBusy(null);
      }
    })();
  }

  function leave(tableId: string) {
    void (async () => {
      setBusy('leave');
      setFailure(null);
      setNotice(null);
      try {
        const seated = account?.agents.find((agent) => agent.seat?.tableId === tableId);
        if (!seated) throw new Error('You have no agent at that table.');
        const response = await fetch('/api/tables/leave', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId: seated.id }),
        });
        const body = (await response.json()) as { error?: string; pending?: boolean };
        if (!response.ok) throw new Error(body.error ?? 'Could not leave the table.');
        // A hand already in progress owns the chips in front of the agent, so
        // the seat is released once that hand is on record, not immediately.
        setNotice(body.pending ? 'Leaving once the current hand finishes.' : null);
        lobby.reload();
        await refresh();
      } catch (error) {
        setFailure(error instanceof Error ? error.message : 'Could not leave the table.');
      } finally {
        setBusy(null);
      }
    })();
  }

  return {
    busy,
    failure,
    notice,
    seat,
    leave,
    dismiss: () => {
      setFailure(null);
      setNotice(null);
    },
  };
}
