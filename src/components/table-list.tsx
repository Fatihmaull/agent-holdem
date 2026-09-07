'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { formatBlurb, formatChips, stakeOptions } from '@/lib/economy';
import type { TableFormat } from '@/lib/economy';
import { useAccount } from './account-context';
import { ChipDot } from './table-art';
import { seatsTaken, type Lobby, type LobbyTable } from './use-lobby';
import { Badge, Button, ButtonLink, Card, EmptyState, LiveBadge, SegmentedControl } from './ui';

type FormatFilter = 'all' | TableFormat;

/**
 * The lobby, laid out the way a poker room lobby is: one full-width row per
 * table, the same columns in the same order every time, and the two filters a
 * player actually uses on top. A table is named by its format and its stakes,
 * because those are the two things being chosen between.
 */
export function TableList({
  lobby,
  filters = true,
  limit,
  onSeat,
  onLeave,
  busy,
}: {
  lobby: Lobby;
  /** Off for the short list on the home page, which shows the whole roster. */
  filters?: boolean;
  limit?: number;
  onSeat: (tableId: string) => void;
  onLeave: () => void;
  /** The table id being seated, or `leave` while a seat is being given up. */
  busy: string | null;
}) {
  const [format, setFormat] = useState<FormatFilter>('all');
  const [stakes, setStakes] = useState('all');
  const [openOnly, setOpenOnly] = useState(false);

  const counts = useMemo(() => {
    const tally = { all: lobby.tables.length } as Record<FormatFilter, number>;
    for (const table of lobby.tables) tally[table.format] = (tally[table.format] ?? 0) + 1;
    return tally;
  }, [lobby.tables]);

  const visible = useMemo(() => {
    const rows = lobby.tables.filter((table) => {
      if (format !== 'all' && table.format !== format) return false;
      if (stakes !== 'all' && `${table.smallBlind}/${table.bigBlind}` !== stakes) return false;
      if (openOnly && seatsTaken(table) >= table.seatCount) return false;
      return true;
    });
    return limit ? rows.slice(0, limit) : rows;
  }, [lobby.tables, format, stakes, openOnly, limit]);

  return (
    <div>
      {filters ? (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <SegmentedControl<FormatFilter>
            label="Filter by format"
            value={format}
            onChange={setFormat}
            options={[
              { value: 'all', label: 'All tables', count: counts.all },
              { value: 'heads-up', label: 'Heads-Up', count: counts['heads-up'] ?? 0 },
              { value: '4-max', label: '4-Max', count: counts['4-max'] ?? 0 },
              { value: '6-max', label: '6-Max', count: counts['6-max'] ?? 0 },
            ]}
          />

          <label className="flex items-center gap-2 text-sm text-muted">
            Stakes
            <select
              value={stakes}
              onChange={(event) => setStakes(event.target.value)}
              className="select-field mono h-9 rounded-control border border-line-input bg-surface pl-2.5 text-[0.8125rem] text-ink"
            >
              <option value="all">Any</option>
              {stakeOptions().map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <label className="ml-auto flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={openOnly}
              onChange={(event) => setOpenOnly(event.target.checked)}
              className="checkbox-field"
            />
            Open seats only
          </label>
        </div>
      ) : null}

      <Card className="overflow-hidden">
        {/* The column heads exist on wide screens only. Narrow rows label their own cells. */}
        <div className="hidden grid-cols-[minmax(11rem,1.4fr)_6rem_7rem_minmax(8rem,1fr)_6rem_11.5rem] items-center gap-4 border-b border-line bg-surface-2 px-5 py-2.5 lg:grid">
          <span className="label text-faint">Table</span>
          <span className="label text-faint">Blinds</span>
          <span className="label text-faint">Buy-in</span>
          <span className="label text-faint">Agents seated</span>
          <span className="label text-faint">Hands</span>
          <span className="label text-right text-faint">Action</span>
        </div>

        {visible.length === 0 ? (
          <EmptyState
            title="No tables match those filters"
            body="Widen the stakes or clear the format filter to see the rest of the roster."
            action={
              <Button
                onClick={() => {
                  setFormat('all');
                  setStakes('all');
                  setOpenOnly(false);
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <ul>
            {visible.map((table) => (
              <TableRow
                key={table.id}
                table={table}
                loaded={lobby.loaded}
                seatedHere={lobby.seatedAt === table.id}
                seatedElsewhere={lobby.seatedAt !== null && lobby.seatedAt !== table.id}
                busy={busy}
                onSeat={() => onSeat(table.id)}
                onLeave={onLeave}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function TableRow({
  table,
  loaded,
  seatedHere,
  seatedElsewhere,
  busy,
  onSeat,
  onLeave,
}: {
  table: LobbyTable;
  loaded: boolean;
  seatedHere: boolean;
  seatedElsewhere: boolean;
  busy: string | null;
  onSeat: () => void;
  onLeave: () => void;
}) {
  const { account } = useAccount();
  const taken = seatsTaken(table);
  const full = taken >= table.seatCount;

  return (
    <li className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-3 border-b border-line px-4 py-4 transition-colors last:border-b-0 hover:bg-surface-2/60 sm:px-5 lg:grid-cols-[minmax(11rem,1.4fr)_6rem_7rem_minmax(8rem,1fr)_6rem_11.5rem] lg:gap-4 lg:py-3.5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/table/${table.id}`} className="text-[0.9375rem] font-semibold text-ink hover:text-accent">
            {table.label}
          </Link>
          {table.live ? <LiveBadge /> : null}
          {seatedHere ? <Badge tone="accent">Your agent</Badge> : null}
        </div>
        <p className="mt-0.5 text-xs text-faint">
          {formatBlurb(table.format)}
          <span className="lg:hidden">
            {' · '}
            {table.smallBlind}/{table.bigBlind} blinds · {formatChips(table.buyIn)} buy-in
          </span>
        </p>
      </div>

      <div className="hidden lg:block">
        <span className="mono text-sm text-ink tabular-nums">
          {table.smallBlind}/{table.bigBlind}
        </span>
      </div>

      <div className="hidden lg:block">
        <span className="mono text-sm text-ink tabular-nums">{formatChips(table.buyIn)}</span>
      </div>

      <div className="col-start-1 flex min-w-0 items-center gap-2 lg:col-start-auto">
        <span className="flex items-center gap-1" aria-hidden>
          {Array.from({ length: table.seatCount }, (_, index) => {
            const seat = table.seats.find((entry) => entry.index === index);
            return <ChipDot key={index} color={seat?.isMine ? 'white' : seat?.color} empty={!seat?.name} size={14} />;
          })}
        </span>
        <span className="mono text-xs text-muted tabular-nums">
          {loaded ? `${taken}/${table.seatCount}` : `–/${table.seatCount}`}
        </span>
      </div>

      <div className="hidden lg:block">
        <span className="mono text-sm text-muted tabular-nums">
          {table.handNumber > 0 ? table.handNumber.toLocaleString('en-US') : '—'}
        </span>
      </div>

      <div className="col-start-2 row-start-1 flex items-center justify-end gap-2 lg:col-start-auto lg:row-start-auto">
        {seatedHere ? (
          <>
            <Button size="sm" onClick={onLeave} disabled={busy !== null}>
              {busy === 'leave' ? 'Leaving…' : 'Leave'}
            </Button>
            <ButtonLink size="sm" tone="primary" href={`/table/${table.id}`}>
              Watch
            </ButtonLink>
          </>
        ) : (
          <>
            <ButtonLink size="sm" href={`/table/${table.id}`}>
              Watch
            </ButtonLink>
            <Button
              size="sm"
              tone="primary"
              onClick={onSeat}
              disabled={busy !== null || full || seatedElsewhere}
              title={
                full
                  ? 'Every seat at this table is taken.'
                  : seatedElsewhere
                    ? 'Your agent plays one table at a time. Leave its current table first.'
                    : !account
                      ? 'Connect a wallet to seat your agent.'
                      : undefined
              }
            >
              {busy === table.id ? 'Seating…' : full ? 'Full' : 'Join'}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
