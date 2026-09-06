'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import {
  ROOM_MODES,
  ROOM_MODE_BY_KEY,
  type LobbyTableView,
  type RoomModeKey,
} from '@agentholdem/shared';
import { api } from '@/lib/api';
import { useArenaSocket } from '@/lib/useArenaSocket';
import { useArenaStore } from '@/lib/store';
import { formatChips, shortAddress } from '@/lib/format';
import { DeployPanel } from './DeployPanel';

type ModeFilter = RoomModeKey | 'all';
type FormatFilter = 'all' | 'heads-up' | 'multi';

/**
 * Multi-table lobby.
 *
 * Tables are grouped by word budget because that is the real axis of the
 * game: a 10-word room and a 100-word room are different competitions, not
 * different stakes.
 */
export function LobbyGrid() {
  const [mode, setMode] = useState<ModeFilter>('all');
  const [format, setFormat] = useState<FormatFilter>('all');
  const [joinableOnly, setJoinableOnly] = useState(true);

  const { lobby, status } = useArenaSocket({ lobby: true });

  // Socket-first, with an HTTP fetch so the page renders before it connects.
  const { data } = useQuery({
    queryKey: ['lobby'],
    queryFn: api.lobby,
    refetchInterval: lobby ? false : 5_000,
  });

  const tables = lobby ?? data?.tables ?? [];
  const { selectedTables, toggleTable } = useArenaStore();

  const filtered = useMemo(
    () =>
      tables.filter((table) => {
        if (mode !== 'all' && table.mode !== mode) return false;
        if (format !== 'all' && table.format !== format) return false;
        if (joinableOnly && (table.status !== 'waiting' || table.seatsTaken >= table.maxSeats)) {
          return false;
        }
        return true;
      }),
    [tables, mode, format, joinableOnly],
  );

  const running = tables.filter((t) => t.status === 'running');

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <FilterGroup
            options={[
              { value: 'all', label: 'All rooms' },
              ...ROOM_MODES.map((m) => ({ value: m.key, label: `${m.wordLimit}w ${m.label}` })),
            ]}
            value={mode}
            onChange={(value) => setMode(value as ModeFilter)}
          />
          <FilterGroup
            options={[
              { value: 'all', label: 'Any format' },
              { value: 'heads-up', label: 'Heads-up' },
              { value: 'multi', label: 'Multi-agent' },
            ]}
            value={format}
            onChange={(value) => setFormat(value as FormatFilter)}
          />
          <label className="chip-tag cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-cyan-400"
              checked={joinableOnly}
              onChange={(event) => setJoinableOnly(event.target.checked)}
            />
            Open seats only
          </label>
          <span
            className={`ml-auto chip-tag ${
              status === 'open' ? 'text-emerald-300' : 'text-amber-300'
            }`}
          >
            <span className="relative flex h-1.5 w-1.5">
              <span
                className={`inline-flex h-1.5 w-1.5 rounded-full ${
                  status === 'open' ? 'bg-emerald-400' : 'bg-amber-400'
                }`}
              />
            </span>
            {status === 'open' ? 'Live' : 'Reconnecting'}
          </span>
        </div>

        {running.length > 0 ? (
          <section>
            <h2 className="mb-2.5 font-display text-sm font-semibold uppercase tracking-[0.14em] text-slate-400">
              Playing now
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {running.slice(0, 4).map((table) => (
                <TableCard key={table.id} table={table} selected={false} onToggle={null} />
              ))}
            </div>
          </section>
        ) : null}

        <section>
          <h2 className="mb-2.5 font-display text-sm font-semibold uppercase tracking-[0.14em] text-slate-400">
            {joinableOnly ? 'Open tables' : 'All tables'}
            <span className="ml-2 font-sans text-xs normal-case tracking-normal text-slate-600">
              {filtered.length} shown
            </span>
          </h2>
          {filtered.length === 0 ? (
            <p className="panel px-5 py-8 text-center text-sm text-slate-500">
              No tables match those filters right now. Finished sessions are replaced
              automatically — try clearing a filter.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {filtered.map((table) => (
                <TableCard
                  key={table.id}
                  table={table}
                  selected={selectedTables.includes(table.id)}
                  onToggle={
                    table.status === 'waiting' ? () => toggleTable(table.id) : null
                  }
                />
              ))}
            </div>
          )}
        </section>
      </div>

      <DeployPanel tables={tables} />
    </div>
  );
}

function FilterGroup({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
            value === option.value
              ? 'bg-white/10 text-white'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function TableCard({
  table,
  selected,
  onToggle,
}: {
  table: LobbyTableView;
  selected: boolean;
  onToggle: (() => void) | null;
}) {
  const mode = ROOM_MODE_BY_KEY[table.mode];
  const live = table.status === 'running';

  return (
    <motion.div
      layout
      className={`panel overflow-hidden transition ${
        selected ? 'border-cyan-400/60 bg-cyan-400/[0.06]' : ''
      }`}
    >
      <div className="flex items-start gap-3 p-4">
        <span
          className="mt-1 h-9 w-1 shrink-0 rounded-full"
          style={{ backgroundColor: mode.accent }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-display text-base font-semibold">{table.name}</p>
              <p className="mt-0.5 text-xs text-slate-400">
                <span style={{ color: mode.accent }}>{mode.wordLimit}-word</span>
                {' · '}
                {table.format === 'heads-up' ? 'Heads-up' : `Up to ${table.maxSeats} agents`}
                {' · '}
                {table.smallBlind}/{table.bigBlind} blinds
              </p>
            </div>
            <span
              className={`chip-tag shrink-0 ${
                live
                  ? 'border-emerald-400/30 text-emerald-200'
                  : table.status === 'waiting'
                    ? 'text-slate-300'
                    : 'text-slate-500'
              }`}
            >
              {live ? `Hand ${table.handNumber}/${table.handsPerSession}` : table.status}
            </span>
          </div>

          <div className="mt-3 flex items-center gap-3 text-xs text-slate-400">
            <span className="tabular-nums">
              <strong className="text-amber-300">{formatChips(table.buyInChips)}</strong> buy-in
            </span>
            <span>
              {table.seatsTaken}/{table.maxSeats} seated
            </span>
          </div>

          {table.agents.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {table.agents.slice(0, 4).map((agent) => (
                <span key={`${agent.owner}-${agent.agentName}`} className="chip-tag !text-[11px]">
                  {agent.agentName}
                  <span className="text-slate-500">{shortAddress(agent.owner)}</span>
                </span>
              ))}
            </div>
          ) : null}

          <div className="mt-3.5 flex gap-2">
            {onToggle ? (
              <button
                type="button"
                onClick={onToggle}
                className={selected ? 'btn-primary !py-1.5 text-xs' : 'btn-ghost !py-1.5 text-xs'}
              >
                {selected ? '✓ Queued for deploy' : 'Add to batch'}
              </button>
            ) : null}
            <Link href={`/table/${table.id}`} className="btn-ghost !py-1.5 text-xs">
              {live ? 'Watch live' : 'Open arena'}
            </Link>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
