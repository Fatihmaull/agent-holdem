"use client";

import { useEffect, useState } from "react";
import { ACT_CLOCK_MS } from "@/lib/pacing";
import { agentHex } from "./table-art";
import { Badge } from "./ui";

export interface BrainState {
  seatName: string | null;
  color: string | null;
  street: string;
  reasoning: string;
  streaming: boolean;
  equity: number | null;
  potOdds: number | null;
  made: string | null;
  draws: string[];
  action: string | null;
  amount: number;
  outcome: "decided" | "timeout" | "error" | null;
  failure: string | null;
  elapsedMs: number | null;
  /** What the agent said out loud, if it said anything. */
  say?: string | null;
}

/**
 * What the agent is thinking, and why it is trustworthy. The panel is the
 * reasoning and the decision it produced, in words a first-time reader knows.
 *
 * It also tells the truth about itself. A decision the model never made is
 * reported as a timeout, never dressed up as a fold, because the whole point
 * of the panel is that it is the instrument rather than the show.
 */
export function ThinkingPanel({
  brain,
  deadline,
  footnote,
}: {
  brain: BrainState | null;
  /** Epoch milliseconds the act clock expires, if a seat is thinking. */
  deadline?: number | null;
  /** Context for a panel that is replaying rather than watching live. */
  footnote?: string | null;
}) {
  // The agent's own colour marks whose panel this is and nothing else. The
  // meters and the caret are the instrument, and an instrument that changes
  // colour with whoever is being measured is harder to read, not easier.
  const hex = agentHex(brain?.color);
  const reasoning = prose(brain?.reasoning ?? "");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line px-4 py-3">
        <div className="flex min-h-6 items-center gap-2">
          {brain?.seatName ? (
            <>
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{
                  background: `color-mix(in srgb, ${hex} 55%, #1f2b28)`,
                }}
                aria-hidden
              />
              <span className="truncate text-sm font-semibold text-ink">
                {brain.seatName}
              </span>
              <span className="shrink-0 text-sm text-muted">is deciding</span>
              <Badge className="ml-auto capitalize">{brain.street}</Badge>
            </>
          ) : (
            <span className="text-sm text-muted">
              Nobody is deciding right now
            </span>
          )}
        </div>
        <ActClock deadline={deadline ?? null} />
      </div>

      <div
        className="scroll-y min-h-0 flex-1 px-4 py-4"
        data-panel-scroll
        tabIndex={0}
      >
        <p className="label mb-2 text-faint">Its reasoning</p>
        {reasoning || brain?.streaming ? (
          // Not a live region. Reasoning arrives a token at a time and
          // announcing each one makes the panel unusable with a screen reader.
          // The decision below is announced once instead, when it settles.
          <p
            className={`text-sm leading-relaxed text-ink ${brain?.streaming ? "caret" : ""}`}
          >
            {reasoning || (
              <span className="text-faint">Reading the board…</span>
            )}
          </p>
        ) : (
          <p className="text-sm leading-relaxed text-muted">
            Nothing to show yet. When a hand is dealt, the agent whose turn it
            is writes out its thinking here before it acts, and you can read it
            while its chips are still at risk.
          </p>
        )}

        {brain?.failure ? (
          <p className="mt-4 rounded-control border border-warning/35 bg-warning/10 px-3 py-2 text-sm text-ink">
            {brain.seatName ?? "This agent"} {brain.failure}. The seat{" "}
            {brain.action === "check" ? "checked" : "folded"} automatically.
          </p>
        ) : null}
      </div>

      <div
        className="shrink-0 border-t border-line px-4 py-3"
        aria-live="polite"
        aria-atomic="true"
      >
        <p className="label mb-1.5 text-faint">It decided</p>
        <div className="min-h-11">
          {brain?.action ? (
            <>
              <div className="flex items-baseline gap-3">
                <span className="text-base font-semibold text-ink capitalize">
                  {brain.action}
                  {brain.amount > 0
                    ? ` ${brain.amount.toLocaleString("en-US")}`
                    : ""}
                </span>
                {brain.elapsedMs != null ? (
                  <span className="mono ml-auto text-xs text-faint tabular-nums">
                    took {(brain.elapsedMs / 1000).toFixed(1)}s
                  </span>
                ) : null}
              </div>
              {/*
              Table talk lives here rather than on the felt. A bubble over a
              seat has to share the strip of cloth between that seat and the
              board with its bet and its action, and the bet and the action are
              the two things a spectator cannot afford to have covered.
            */}
              {brain.say ? (
                <p className="mt-1.5 text-sm text-muted italic">
                  “{brain.say}”
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-faint">Waiting on this decision.</p>
          )}
        </div>
        {footnote ? (
          <p className="mt-1.5 truncate text-xs text-faint">{footnote}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * How long is left on the decision. It is a plain progress bar because a
 * countdown is one of the few things every reader already knows how to read.
 *
 * It keeps its space between decisions rather than unmounting. A clock that
 * comes and goes with every seat drags the whole panel up and down under it,
 * which makes reasoning that is being read at the time jump on the line.
 */
function ActClock({ deadline }: { deadline: number | null }) {
  const [remaining, setRemaining] = useState(() =>
    deadline == null ? 0 : Math.max(0, deadline - Date.now()),
  );

  useEffect(() => {
    if (deadline == null) return;
    const tick = () => setRemaining(Math.max(0, deadline - Date.now()));
    tick();
    const timer = setInterval(tick, 100);
    return () => clearInterval(timer);
  }, [deadline]);

  const running = deadline != null;
  const fraction = running
    ? Math.max(0, Math.min(1, remaining / ACT_CLOCK_MS))
    : 0;

  return (
    <div
      className={`mt-2.5 transition-opacity duration-200 ${running ? "" : "opacity-0"}`}
      aria-hidden={!running}
    >
      <div className="h-1 w-full overflow-hidden rounded-full bg-surface-3">
        <div
          className="h-full rounded-full bg-live transition-[width] duration-100 ease-linear"
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
      <p className="mono mt-1.5 text-xs text-faint tabular-nums">
        {(remaining / 1000).toFixed(1)}s left to act
      </p>
    </div>
  );
}

/**
 * The model writes its reasoning, then a JSON object with the action. Only the
 * reasoning belongs on screen, so the object is cut off mid-stream as well as
 * at the end rather than being shown arriving character by character.
 */
function prose(text: string): string {
  // Only a brace that starts the decision object ends the prose. A brace inside
  // a sentence is just a brace, and cutting there loses the rest of the thought.
  const object = text.search(/\{\s*"/);
  return (object >= 0 ? text.slice(0, object) : text)
    .replace(/```(?:json)?/g, "")
    .trim();
}
