'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PromptTemplate, RoomModeKey } from '@agentholdem/shared';

export interface DraftTemplate {
  id: string | null;
  name: string;
  prompt: string;
}

interface ArenaState {
  /** The persona currently being written in the Strategy Lab. */
  draft: DraftTemplate;
  /** The room budget the live word counter is measuring against. */
  targetMode: RoomModeKey;
  /** Tables queued up for the next batch deploy. */
  selectedTables: string[];
  /** Name the deployed agents wear at the table. */
  agentName: string;
  /** Server-backed library, mirrored locally so the lab works offline. */
  templates: PromptTemplate[];

  setDraft: (patch: Partial<DraftTemplate>) => void;
  loadTemplate: (template: PromptTemplate) => void;
  clearDraft: () => void;
  setTargetMode: (mode: RoomModeKey) => void;
  setAgentName: (name: string) => void;
  toggleTable: (id: string) => void;
  clearSelection: () => void;
  setTemplates: (templates: PromptTemplate[]) => void;
}

const EMPTY_DRAFT: DraftTemplate = { id: null, name: '', prompt: '' };

/**
 * Global manager state.
 *
 * Persisted to localStorage so a half-written strategy and a queued batch
 * survive a refresh — the tab is meant to be closeable at any moment, and
 * that should include mid-compose.
 */
export const useArenaStore = create<ArenaState>()(
  persist(
    (set) => ({
      draft: EMPTY_DRAFT,
      targetMode: 'tactical',
      selectedTables: [],
      agentName: '',
      templates: [],

      setDraft: (patch) => set((s) => ({ draft: { ...s.draft, ...patch } })),
      loadTemplate: (template) =>
        set({
          draft: { id: template.id, name: template.name, prompt: template.prompt },
        }),
      clearDraft: () => set({ draft: EMPTY_DRAFT }),
      setTargetMode: (targetMode) => set({ targetMode }),
      setAgentName: (agentName) => set({ agentName }),
      toggleTable: (id) =>
        set((s) => ({
          selectedTables: s.selectedTables.includes(id)
            ? s.selectedTables.filter((t) => t !== id)
            : [...s.selectedTables, id],
        })),
      clearSelection: () => set({ selectedTables: [] }),
      setTemplates: (templates) => set({ templates }),
    }),
    {
      name: 'agentholdem-manager',
      partialize: (state) => ({
        draft: state.draft,
        targetMode: state.targetMode,
        agentName: state.agentName,
        selectedTables: state.selectedTables,
      }),
    },
  ),
);
