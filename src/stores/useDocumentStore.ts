import { create } from 'zustand';
import { db } from '../db/manuscriptDb';
import { expandCitationNums, formatCitationGroup, mergeAdjacentCitations } from '../services/citations';
import type { DocumentRow } from '../types';

interface DocumentState {
  title: string;
  content: string;
  saveState: 'Draft' | 'Saved' | 'Auto-saved';
  citationRegistry: Record<string, number>;
  citationCounter: number;

  setTitle: (title: string) => void;
  setContent: (content: string) => void;
  setSaveState: (s: DocumentState['saveState']) => void;
  setCitationRegistry: (reg: Record<string, number>) => void;

  /**
   * Register a new source citation. Returns existing number if already registered,
   * or assigns the next counter value. Does NOT modify HTML - caller does that.
   */
  insertCitation: (sourceId: string) => number;

  /**
   * Remove a source citation from the registry. Returns new HTML and new registry
   * after stripping and renumbering. Caller must apply the new HTML to the editor.
   */
  removeCitation: (sourceId: string, currentHtml: string) => { newHtml: string; newRegistry: Record<string, number> };

  /**
   * Scan the HTML for citation patterns and assign sequential numbers in order of
   * appearance. Returns new HTML (remapped numbers) and the new registry.
   */
  renumberCitations: (currentHtml: string) => { newHtml: string; newRegistry: Record<string, number> };

  /** Reset to blank document state. */
  resetDocument: () => void;

  /** Load from Dexie, migrating from localforage if needed. */
  initialize: () => Promise<void>;

  /** Persist current state to Dexie. */
  persist: () => Promise<void>;
}

const DEFAULT_CONTENT = '<p>Start writing your manuscript here, or click "New Manuscript" to begin with an IMRAD template.</p>';

export const useDocumentStore = create<DocumentState>((set, get) => ({
  title: 'Untitled Manuscript',
  content: DEFAULT_CONTENT,
  saveState: 'Draft',
  citationRegistry: {},
  citationCounter: 0,

  setTitle: (title) => set({ title, saveState: 'Draft' }),
  setContent: (content) => set({ content, saveState: 'Draft' }),
  setSaveState: (saveState) => set({ saveState }),
  setCitationRegistry: (citationRegistry) => set({ citationRegistry }),

  insertCitation: (sourceId) => {
    const { citationRegistry, citationCounter } = get();
    if (citationRegistry[sourceId]) return citationRegistry[sourceId];
    const num = citationCounter + 1;
    set({ citationRegistry: { ...citationRegistry, [sourceId]: num }, citationCounter: num });
    return num;
  },

  removeCitation: (sourceId, currentHtml) => {
    const { citationRegistry } = get();
    const removed = citationRegistry[sourceId];
    if (!removed) return { newHtml: currentHtml, newRegistry: citationRegistry };

    const { [sourceId]: _removed, ...rest } = citationRegistry;

    // Strip the number from every group that contains it
    const stripped = currentHtml.replace(/\[([\d,\-]+)\]/g, (_, inner) => {
      const nums = expandCitationNums(inner).filter(n => n !== removed);
      return nums.length > 0 ? formatCitationGroup(nums) : '';
    });

    // Renumber remaining in original order
    const sorted = Object.entries(rest).sort((a, b) => a[1] - b[1]);
    const newRegistry: Record<string, number> = {};
    sorted.forEach(([id], i) => { newRegistry[id] = i + 1; });

    const numToId: Record<number, string> = {};
    for (const [id, num] of Object.entries(rest)) numToId[num] = id;

    const remapped = stripped.replace(/\[([\d,\-]+)\]/g, (_, inner) => {
      const nums = [...new Set(expandCitationNums(inner).map(n => {
        const id = numToId[n];
        return id && newRegistry[id] ? newRegistry[id] : n;
      }))].sort((a, b) => a - b);
      return nums.length > 0 ? formatCitationGroup(nums) : '';
    });

    const newHtml = mergeAdjacentCitations(remapped);
    set({ citationRegistry: newRegistry, citationCounter: sorted.length });
    return { newHtml, newRegistry };
  },

  renumberCitations: (currentHtml) => {
    const { citationRegistry } = get();
    if (Object.keys(citationRegistry).length === 0) {
      return { newHtml: currentHtml, newRegistry: citationRegistry };
    }

    const numToId: Record<number, string> = {};
    for (const [id, num] of Object.entries(citationRegistry)) numToId[num] = id;

    // Scan appearance order
    const seenIds: string[] = [];
    const seenNums = new Set<number>();
    const pat = /\[([\d,\-]+)\]/g;
    let m;
    while ((m = pat.exec(currentHtml)) !== null) {
      for (const n of expandCitationNums(m[1])) {
        if (numToId[n] && !seenNums.has(n)) { seenNums.add(n); seenIds.push(numToId[n]); }
      }
    }
    // Append any sources not yet in order
    for (const id of Object.keys(citationRegistry)) {
      if (!seenIds.includes(id)) seenIds.push(id);
    }

    const newRegistry: Record<string, number> = {};
    seenIds.forEach((id, i) => { newRegistry[id] = i + 1; });

    const remapped = currentHtml.replace(/\[([\d,\-]+)\]/g, (_, inner) => {
      const nums = [...new Set(expandCitationNums(inner).map(n => {
        const id = numToId[n];
        return id && newRegistry[id] ? newRegistry[id] : n;
      }))].sort((a, b) => a - b);
      return formatCitationGroup(nums);
    });
    const newHtml = mergeAdjacentCitations(remapped);
    set({ citationRegistry: newRegistry, citationCounter: seenIds.length });
    return { newHtml, newRegistry };
  },

  resetDocument: () => set({
    title: 'Untitled Manuscript',
    content: DEFAULT_CONTENT,
    saveState: 'Draft',
    citationRegistry: {},
    citationCounter: 0,
  }),

  initialize: async () => {
    try {
      // Try Dexie first
      const row = await db.documents.get('current');
      if (row) {
        set({
          title: row.title,
          content: row.content,
          saveState: row.saveState,
          citationRegistry: row.citationRegistry,
          citationCounter: row.citationCounter,
        });
        return;
      }

      // Fall back to legacy localforage
      const localforage = await import('localforage');
      const data: any = await localforage.default.getItem('manuscript-ai-editor-autosave');
      if (data?.content) {
        const registry: Record<string, number> = data.citationRegistry || {};
        set({
          title: data.title || 'Untitled Manuscript',
          content: data.content,
          saveState: 'Auto-saved',
          citationRegistry: registry,
          citationCounter: Object.keys(registry).length,
        });
        // Migrate to Dexie immediately
        await get().persist();
        // Clean up old key
        await localforage.default.removeItem('manuscript-ai-editor-autosave');
      }
    } catch (err) {
      console.error('DocumentStore.initialize failed:', err);
    }
  },

  persist: async () => {
    const { title, content, saveState, citationRegistry, citationCounter } = get();
    const row: DocumentRow = {
      id: 'current',
      title,
      content,
      saveState,
      citationRegistry,
      citationCounter,
      updatedAt: Date.now(),
    };
    await db.documents.put(row);
  },
}));
