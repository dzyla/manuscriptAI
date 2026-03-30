import { create } from 'zustand';
import { db } from '../db/manuscriptDb';
import type { ManuscriptSource, SourceRow } from '../types';

interface SourceState {
  sources: ManuscriptSource[];
  pendingApiSources: ManuscriptSource[];

  setSources: (sources: ManuscriptSource[]) => void;
  addSources: (newSources: ManuscriptSource[]) => void;
  updateSource: (id: string, patch: Partial<ManuscriptSource>) => void;
  removeSource: (id: string) => void;
  clearSources: () => void;
  setPendingApiSources: (sources: ManuscriptSource[]) => void;
  clearPendingApiSources: () => void;

  /** Load from Dexie, migrating from localforage if needed. */
  initialize: () => Promise<void>;

  /** Persist sources to Dexie. */
  persist: () => Promise<void>;
}

export const useSourceStore = create<SourceState>((set, get) => ({
  sources: [],
  pendingApiSources: [],

  setSources: (sources) => set({ sources }),
  addSources: (newSources) => set((state) => {
    const existingIds = new Set(state.sources.map(s => s.id));
    const unique = newSources.filter(s => !existingIds.has(s.id));
    return { sources: [...state.sources, ...unique] };
  }),
  updateSource: (id, patch) => set((state) => ({
    sources: state.sources.map(s => s.id === id ? { ...s, ...patch } : s),
  })),
  removeSource: (id) => set((state) => ({
    sources: state.sources.filter(s => s.id !== id),
  })),
  clearSources: () => set({ sources: [] }),
  setPendingApiSources: (pendingApiSources) => set({ pendingApiSources }),
  clearPendingApiSources: () => set({ pendingApiSources: [] }),

  initialize: async () => {
    try {
      const rows = await db.sources.orderBy('order').toArray();
      if (rows.length > 0) {
        set({ sources: rows.map(({ order: _order, ...source }) => source as ManuscriptSource) });
        return;
      }

      // Migrate from localforage
      const localforage = await import('localforage');
      const saved: any = await localforage.default.getItem('manuscript-sources');
      if (saved && Array.isArray(saved)) {
        set({ sources: saved });
        await get().persist();
        await localforage.default.removeItem('manuscript-sources');
      }
    } catch (err) {
      console.error('SourceStore.initialize failed:', err);
    }
  },

  persist: async () => {
    const { sources } = get();
    await db.sources.clear();
    if (sources.length > 0) {
      await db.sources.bulkPut(
        sources.map((source, order) => ({ ...source, order } as SourceRow))
      );
    }
  },
}));
