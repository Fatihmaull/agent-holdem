'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useAccount } from 'wagmi';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ROOM_MODES,
  STARTER_TEMPLATES,
  countWords,
  validatePromptForMode,
  type RoomModeKey,
} from '@agentholdem/shared';
import { api } from '@/lib/api';
import { useArenaStore } from '@/lib/store';
import { WordMeter } from './WordMeter';

/**
 * The Strategy Lab: write a persona, watch it fit (or not) inside each room's
 * word budget, save it to the library, then deploy it from the lobby.
 */
export function StrategyLab() {
  const { address } = useAccount();
  const queryClient = useQueryClient();
  const { draft, setDraft, loadTemplate, clearDraft, targetMode, setTargetMode } =
    useArenaStore();
  const [notice, setNotice] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['templates', address],
    queryFn: () => api.templates(address as string),
    enabled: Boolean(address),
  });

  const templates = data?.templates ?? [];

  const save = useMutation({
    mutationFn: () =>
      api.saveTemplate({
        owner: address as string,
        name: draft.name.trim() || 'Untitled strategy',
        prompt: draft.prompt,
        ...(draft.id ? { id: draft.id } : {}),
      }),
    onSuccess: ({ template }) => {
      loadTemplate(template);
      setNotice(`Saved "${template.name}" (${template.words} words).`);
      void queryClient.invalidateQueries({ queryKey: ['templates', address] });
    },
    onError: (error: Error) => setNotice(error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteTemplate(id, address as string),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['templates', address] });
    },
  });

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const words = countWords(draft.prompt);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="font-display text-lg font-semibold">Prompt Strategy Lab</h2>
            <p className="text-xs text-slate-400">
              Two layers reach the model: the table state, and this brief.
            </p>
          </div>
          <div className="flex gap-1 rounded-xl border border-white/10 bg-slate-950/60 p-1">
            {ROOM_MODES.map((mode) => (
              <button
                key={mode.key}
                type="button"
                onClick={() => setTargetMode(mode.key as RoomModeKey)}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  targetMode === mode.key
                    ? 'bg-white/10 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                style={targetMode === mode.key ? { color: mode.accent } : undefined}
              >
                {mode.wordLimit}w
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-4 p-5">
          <div>
            <label className="stat-label" htmlFor="template-name">
              Strategy name
            </label>
            <input
              id="template-name"
              className="field mt-1.5"
              placeholder="The Mathematician"
              value={draft.name}
              maxLength={60}
              onChange={(event) => setDraft({ name: event.target.value })}
            />
          </div>

          <div>
            <label className="stat-label" htmlFor="template-prompt">
              Persona &amp; tactics
            </label>
            <textarea
              id="template-prompt"
              className="field mt-1.5 min-h-[190px] resize-y leading-relaxed"
              placeholder="Play pot odds strictly. Fold marginal spots. Value bet relentlessly."
              value={draft.prompt}
              onChange={(event) => setDraft({ prompt: event.target.value })}
            />
          </div>

          <WordMeter text={draft.prompt} mode={targetMode} />

          {/* Which rooms this brief can actually enter, at a glance. An empty
              draft is simply unwritten, not wrong, so it stays neutral. */}
          <div className="flex flex-wrap gap-2">
            {ROOM_MODES.map((mode) => {
              const check = validatePromptForMode(draft.prompt, mode.key as RoomModeKey);
              const tone = words === 0
                ? 'text-slate-500'
                : check.ok
                  ? 'border-emerald-400/30 text-emerald-200'
                  : 'border-rose-400/25 text-rose-200/80';
              return (
                <span
                  key={mode.key}
                  className={`chip-tag ${tone}`}
                  title={check.ok ? 'Fits this room' : check.reason}
                >
                  {words === 0 ? '·' : check.ok ? '✓' : '✕'} {mode.label} · {mode.wordLimit}w
                </span>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              className="btn-primary"
              disabled={!address || words === 0 || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : draft.id ? 'Update strategy' : 'Save to library'}
            </button>
            <button type="button" className="btn-ghost" onClick={clearDraft}>
              New strategy
            </button>
            {!address ? (
              <span className="text-xs text-slate-500">Connect a wallet to save.</span>
            ) : null}
          </div>

          <AnimatePresence>
            {notice ? (
              <motion.p
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs text-cyan-100"
              >
                {notice}
              </motion.p>
            ) : null}
          </AnimatePresence>
        </div>
      </section>

      <div className="space-y-6">
        <section className="panel">
          <div className="panel-header">
            <h3 className="font-display text-base font-semibold">Your library</h3>
            <span className="text-xs text-slate-500">{templates.length} saved</span>
          </div>
          <div className="max-h-[340px] space-y-2 overflow-y-auto p-4 scroll-thin">
            {templates.length === 0 ? (
              <p className="px-1 py-6 text-center text-sm text-slate-500">
                Nothing saved yet. Write a brief and save it — one strategy can be deployed to
                several tables at once.
              </p>
            ) : (
              templates.map((template) => (
                <div
                  key={template.id}
                  className="group rounded-xl border border-white/10 bg-white/[0.02] p-3 transition hover:border-white/20"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{template.name}</p>
                      <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-slate-400">
                        {template.prompt}
                      </p>
                    </div>
                    <span className="chip-tag shrink-0">{template.words}w</span>
                  </div>
                  <div className="mt-2.5 flex gap-2">
                    <button
                      type="button"
                      className="btn-ghost !px-2.5 !py-1 text-xs"
                      onClick={() => loadTemplate(template)}
                    >
                      Load
                    </button>
                    <button
                      type="button"
                      className="btn-ghost !px-2.5 !py-1 text-xs text-rose-200 hover:border-rose-400/40"
                      onClick={() => remove.mutate(template.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h3 className="font-display text-base font-semibold">Starter briefs</h3>
          </div>
          <div className="space-y-2 p-4">
            {STARTER_TEMPLATES.map((starter) => (
              <button
                key={starter.name}
                type="button"
                onClick={() => setDraft({ id: null, name: starter.name, prompt: starter.prompt })}
                className="w-full rounded-xl border border-white/10 bg-white/[0.02] p-3 text-left transition hover:border-cyan-400/40 hover:bg-cyan-400/[0.05]"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">{starter.name}</span>
                  <span className="chip-tag">{countWords(starter.prompt)}w</span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-400">
                  {starter.prompt}
                </p>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
