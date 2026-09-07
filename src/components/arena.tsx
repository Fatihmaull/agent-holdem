"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatBlurb, formatChips } from "@/lib/economy";
import type { TableFormat } from "@/lib/economy";
import type { TableView } from "@/server/view";
import { useAccount } from "./account-context";
import { Felt } from "./felt";
import { ThinkingPanel, type BrainState } from "./thinking-panel";
import { ChipDot, DealerButton, agentHex } from "./table-art";
import { seatLabel, useTableStream } from "./use-table-stream";
import { useLobby } from "./use-lobby";
import { useSeating } from "./use-seating";
import { Badge, Button, ButtonLink, Card, LiveBadge } from "./ui";

type Tab = "thinking" | "players" | "log";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "thinking", label: "Thinking" },
  { id: "players", label: "Players" },
  { id: "log", label: "Hand log" },
];

/**
 * The watch page, laid out the way any live-video page is: one big stage, and a
 * side panel with named tabs beside it. The panel is the reason to be here, so
 * it says what it is at the top of every tab rather than presenting a wall of
 * unlabelled figures.
 */
export function Arena({ tableId }: { tableId: string }) {
  const {
    table,
    streaming,
    isStreaming,
    idleReason,
    connected,
    moved,
    potKey,
    actionKeys,
  } = useTableStream(tableId);
  const { account } = useAccount();
  const lobby = useLobby();
  const seating = useSeating(lobby);
  const [tab, setTab] = useState<Tab>("thinking");
  // A wallet holds one seat per table, so at most one of its agents is in
  // this hand — and only that one's cards come through un-redacted.
  const myAgentId = account?.agents.find((agent) => agent.seat?.tableId === tableId)?.id ?? null;

  // Picking a tab leaves focus on the tab button, whose nearest scrollable
  // ancestor is the page, so the arrow keys scroll the page out from under the
  // panel the reader just asked for. Hand focus to the panel's own scroller
  // instead, but only when a tab was actually picked: stealing focus on first
  // paint would drag a reader away from wherever they came in.
  const panel = useRef<HTMLDivElement>(null);
  const picked = useRef(false);
  useEffect(() => {
    if (!picked.current) return;
    panel.current
      ?.querySelector<HTMLElement>("[data-panel-scroll]")
      ?.focus({ preventScroll: true });
  }, [tab]);

  const brain: BrainState | null = table?.brain
    ? {
        seatName: table.brain.seatName,
        color: table.brain.color,
        street: table.brain.street,
        reasoning: isStreaming ? streaming : table.brain.reasoning,
        streaming: isStreaming,
        equity: table.brain.equity,
        potOdds: table.brain.potOdds,
        made: table.brain.handRead?.made ?? null,
        draws: drawsOf(table.brain.handRead),
        action: table.brain.action,
        amount: table.brain.amount ?? 0,
        outcome: table.brain.outcome,
        failure: table.brain.failure,
        elapsedMs: table.brain.elapsedMs,
        say:
          table.seats.find((seat) => seat.index === table.brain?.seat)?.say ??
          null,
      }
    : null;

  return (
    <div className="page mx-auto w-full max-w-[104rem] px-4 py-4 sm:px-6 sm:py-6">
      <TableBar
        table={table}
        tableId={tableId}
        connected={connected}
        seatedHere={lobby.seatedAt.includes(tableId)}
        busy={seating.busy}
        onSeat={() => seating.seat(tableId)}
        onLeave={() => seating.leave(tableId)}
      />

      {seating.failure ? (
        <p
          role="status"
          className="mt-3 rounded-card border border-danger/40 bg-danger-soft px-4 py-2.5 text-sm text-ink"
        >
          {seating.failure}
        </p>
      ) : null}

      <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_25rem]">
        <div className="min-w-0">
          <Felt
            table={table}
            myAgentId={myAgentId}
            idleReason={idleReason}
            moved={moved}
            potKey={potKey}
            actionKeys={actionKeys}
            onSeat={() => seating.seat(tableId)}
            canSeat={lobby.seatedAt === null && seating.busy === null}
          />
        </div>

        {/*
          The panel is exactly as tall as the felt beside it and never taller.
          Its height comes from the stage, not from what is in it, so switching
          to the hand log scrolls inside the panel instead of stretching the
          page and dragging the table out from under the reader.
        */}
        <Card className="flex h-[32rem] min-w-0 flex-col overflow-hidden lg:h-[var(--stage-h)]">
          <div
            role="tablist"
            aria-label="Table panels"
            className="flex shrink-0 border-b border-line"
          >
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                id={`tab-${entry.id}`}
                aria-controls={`panel-${entry.id}`}
                aria-selected={tab === entry.id}
                onClick={() => {
                  picked.current = true;
                  setTab(entry.id);
                }}
                className={`flex-1 border-b-2 px-3 py-2.5 text-[0.8125rem] font-medium transition-colors ${
                  tab === entry.id
                    ? "border-accent text-ink"
                    : "border-transparent text-muted hover:text-ink"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div
            ref={panel}
            role="tabpanel"
            id={`panel-${tab}`}
            aria-labelledby={`tab-${tab}`}
            className="min-h-0 flex-1"
          >
            {tab === "thinking" ? (
              <ThinkingPanel brain={brain} deadline={table?.deadline ?? null} />
            ) : tab === "players" ? (
              <PlayersPanel table={table} myAgentId={myAgentId} />
            ) : (
              <LogPanel table={table} />
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

/**
 * Everything you need to know about the table before you look at it, and the
 * one control that acts on it. The breadcrumb is here because this is the only
 * page you can reach from a link and land on cold.
 */
function TableBar({
  table,
  tableId,
  connected,
  seatedHere,
  busy,
  onSeat,
  onLeave,
}: {
  table: TableView | null;
  tableId: string;
  connected: boolean;
  seatedHere: boolean;
  busy: string | null;
  onSeat: () => void;
  onLeave: () => void;
}) {
  const seated = table?.seats.filter((seat) => seat.agentId).length ?? 0;
  const full = table ? seated >= table.seatCount : false;

  return (
    <div>
      <nav
        aria-label="Breadcrumb"
        className="mb-3 flex items-center gap-1.5 text-sm text-faint"
      >
        <Link href="/tables" className="transition-colors hover:text-ink">
          Tables
        </Link>
        <span aria-hidden>/</span>
        <span className="text-muted">{table?.label ?? tableId}</span>
      </nav>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl text-ink sm:text-2xl">
              {table?.label ?? "Loading table…"}
            </h1>
            {connected ? (
              <LiveBadge
                label={table && table.street !== "idle" ? "Live" : "Connected"}
              />
            ) : null}
            {seatedHere ? <Badge tone="accent">Your agent</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-muted">
            {table ? (
              <>
                {formatBlurb(table.format as TableFormat)} · {table.smallBlind}/
                {table.bigBlind} blinds · {formatChips(table.buyIn)} buy-in ·{" "}
                {seated}/{table.seatCount} seated
                {table.handNumber > 0
                  ? ` · hand ${table.handNumber.toLocaleString("en-US")}`
                  : ""}
              </>
            ) : (
              "Connecting to the table feed."
            )}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {seatedHere ? (
            <Button onClick={onLeave} disabled={busy !== null}>
              {busy === "leave" ? "Leaving…" : "Leave table"}
            </Button>
          ) : (
            <Button
              tone="primary"
              onClick={onSeat}
              disabled={busy !== null || full}
            >
              {busy === tableId
                ? "Seating…"
                : full
                  ? "Table full"
                  : "Join this table"}
            </Button>
          )}
          <ButtonLink href="/tables" tone="ghost">
            Other tables
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}

/** Who is at the table, with the numbers a spectator checks between hands. */
function PlayersPanel({
  table,
  myAgentId,
}: {
  table: TableView | null;
  myAgentId: string | null;
}) {
  const seats = table?.seats ?? [];

  return (
    <div className="scroll-y h-full p-3" data-panel-scroll tabIndex={0}>
      <p className="px-1 pb-2 text-xs text-faint">
        Every agent at this table and what it has in front of it. Colour is the
        agent&rsquo;s own, on the felt and here alike.
      </p>
      <ul className="space-y-1.5">
        {seats.map((seat) => {
          const mine = Boolean(seat.agentId && seat.agentId === myAgentId);
          const hex = agentHex(mine ? "white" : seat.color);
          return (
            <li
              key={seat.index}
              className="flex items-center gap-3 rounded-control border border-line bg-surface-2 px-3 py-2.5"
            >
              <ChipDot
                color={mine ? "white" : seat.color}
                empty={!seat.agentId}
                size={16}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm text-ink">
                    {seat.agentId ? seatLabel(seat) : `Seat ${seat.index + 1}`}
                  </span>
                  {seat.isDealer ? <DealerButton size={13} /> : null}
                  {mine ? <Badge tone="accent">You</Badge> : null}
                </div>
                <p className="text-xs text-faint">
                  {seat.agentId
                    ? table?.toAct === seat.index
                      ? "Deciding now"
                      : seat.status === "folded"
                        ? "Folded this hand"
                        : seat.status === "all-in"
                          ? "All in"
                          : (seat.lastAction ?? "Waiting")
                    : "Open seat"}
                </p>
              </div>
              {seat.agentId ? (
                <div className="text-right">
                  <div className="mono text-sm text-ink tabular-nums">
                    {formatChips(seat.stack)}
                  </div>
                  {seat.committed > 0 ? (
                    <div
                      className="mono text-xs tabular-nums"
                      style={{ color: hex }}
                    >
                      {formatChips(seat.committed)} in
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Every action at this table, newest last, the way a hand history reads. */
function LogPanel({ table }: { table: TableView | null }) {
  const lines = table?.log ?? [];
  const scroller = useRef<HTMLDivElement>(null);

  // Scroll the log itself rather than asking the newest line to bring itself
  // into view. The panel is a fixed height now, and scrollIntoView on a nested
  // scroller is free to move the page as well to satisfy the request.
  useEffect(() => {
    const box = scroller.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines.length]);

  return (
    <div
      ref={scroller}
      className="scroll-y h-full p-3"
      data-panel-scroll
      tabIndex={0}
    >
      {lines.length === 0 ? (
        <p className="px-1 py-8 text-center text-sm text-muted">
          No hands played yet. Actions appear here as they happen.
        </p>
      ) : (
        <ol className="space-y-1">
          {lines.map((line) => (
            <li
              key={line.id}
              className="entering flex gap-2.5 rounded-[0.375rem] px-2 py-1.5 text-sm odd:bg-surface-2/60"
            >
              <span className="mono shrink-0 text-xs text-faint tabular-nums">
                {clock(line.at)}
              </span>
              <span className="min-w-0 text-muted">{line.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function drawsOf(read: NonNullable<TableView["brain"]>["handRead"]): string[] {
  if (!read) return [];
  return [
    read.flushDraw && "flush draw",
    read.openEnded && "open-ended",
    read.gutshot && "gutshot",
    read.overcards && "two overcards",
  ].filter((value): value is string => typeof value === "string");
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", {
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
  });
}
