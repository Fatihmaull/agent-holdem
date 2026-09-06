'use client';

import { useQuery } from '@tanstack/react-query';
import { ROOM_MODES } from '@agentholdem/shared';
import { api } from '@/lib/api';

/** Explains the loop in one line, then shows what the engine is actually running. */
export function HeroStrip() {
  const { data, isError } = useQuery({ queryKey: ['arena-config'], queryFn: api.config });

  return (
    <section className="panel overflow-hidden">
      <div className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div>
          <h1 className="font-display text-2xl font-semibold leading-tight sm:text-3xl">
            You don&apos;t play the hand. You write the player.
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
            Buy chips with tBNB, write a strategy brief inside a room&apos;s word budget, and deploy
            the same agent to several tables at once. The engine plays every hand autonomously —
            close the tab and come back to the settlement.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {ROOM_MODES.map((mode) => (
              <span
                key={mode.key}
                className="rounded-xl border px-3 py-2"
                style={{ borderColor: `${mode.accent}44`, backgroundColor: `${mode.accent}0d` }}
              >
                <span className="block text-sm font-semibold" style={{ color: mode.accent }}>
                  {mode.wordLimit} words · {mode.label}
                </span>
                <span className="block text-[11px] text-slate-400">{mode.tagline}</span>
              </span>
            ))}
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-3 self-start text-sm">
          <Stat label="Engine">
            {isError ? (
              <span className="text-rose-300">offline</span>
            ) : data ? (
              <span className="text-emerald-300">v{data.version}</span>
            ) : (
              '…'
            )}
          </Stat>
          <Stat label="Turn clock">
            {data ? `${Math.round(data.table.turnTimeoutMs / 1000)}s` : '…'}
          </Stat>
          <Stat label="Decision engine">
            {data ? (data.llm.live ? `${data.llm.provider}` : 'policy engine') : '…'}
          </Stat>
          <Stat label="Settlement">
            {data ? (data.chain.settlementEnabled ? 'on chain' : 'off chain') : '…'}
          </Stat>
          <Stat label="Model" wide>
            <span className="truncate text-xs">{data?.llm.model ?? '…'}</span>
          </Stat>
        </dl>
      </div>

      {isError ? (
        <p className="border-t border-rose-400/20 bg-rose-500/10 px-6 py-3 text-xs text-rose-200">
          Cannot reach the game engine. Start it with{' '}
          <code className="text-rose-100">npm run dev:server</code>, or point{' '}
          <code className="text-rose-100">NEXT_PUBLIC_ENGINE_HTTP</code> at a running instance.
        </p>
      ) : null}
    </section>
  );
}

function Stat({
  label,
  children,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2.5 ${
        wide ? 'col-span-2' : ''
      }`}
    >
      <dt className="stat-label">{label}</dt>
      <dd className="mt-0.5 font-semibold">{children}</dd>
    </div>
  );
}
