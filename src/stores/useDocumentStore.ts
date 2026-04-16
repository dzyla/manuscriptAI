import { create } from 'zustand';
import { db } from '../db/manuscriptDb';
import type { DocumentRow } from '../types';

interface DocumentState {
  title: string;
  content: string;
  saveState: 'Draft' | 'Saved' | 'Auto-saved';
  citationRegistry: Record<string, number>;
  citationCounter: number;
  figureRegistry: Record<string, number>;
  figureCounter: number;

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
   * Remove a source citation from the registry. Accepts the ordered list of source IDs
   * (from AST traversal). Returns the new registry. Caller applies changes to the editor.
   */
  removeCitation: (sourceId: string, orderedSourceIds: string[]) => Record<string, number>;

  /**
   * Assign sequential numbers to sources in the given order (from AST traversal).
   * Returns the new registry. Caller applies changes to the editor.
   */
  renumberCitations: (orderedSourceIds: string[]) => Record<string, number>;

  /**
   * Register a new figure. Returns existing number if already registered,
   * or assigns the next counter value.
   */
  insertFigure: (figureId: string) => number;

  /**
   * Assign sequential numbers to figures in the given order (from AST traversal).
   * Returns the new registry. Caller applies changes to the editor.
   */
  renumberFigures: (orderedFigureIds: string[]) => Record<string, number>;

  /**
   * Remove a figure from the registry and renumber remaining.
   */
  removeFigure: (figureId: string, orderedFigureIds: string[]) => Record<string, number>;

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
  figureRegistry: {},
  figureCounter: 0,

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

  removeCitation: (sourceId, orderedSourceIds) => {
    const filtered = orderedSourceIds.filter(id => id !== sourceId);
    const newRegistry: Record<string, number> = {};
    filtered.forEach((id, i) => { newRegistry[id] = i + 1; });
    set({ citationRegistry: newRegistry, citationCounter: filtered.length });
    return newRegistry;
  },

  renumberCitations: (orderedSourceIds) => {
    if (orderedSourceIds.length === 0) {
      return {};
    }
    const newRegistry: Record<string, number> = {};
    orderedSourceIds.forEach((id, i) => { newRegistry[id] = i + 1; });
    set({ citationRegistry: newRegistry, citationCounter: orderedSourceIds.length });
    return newRegistry;
  },

  insertFigure: (figureId) => {
    const { figureRegistry, figureCounter } = get();
    if (figureRegistry[figureId]) return figureRegistry[figureId];
    const num = figureCounter + 1;
    set({ figureRegistry: { ...figureRegistry, [figureId]: num }, figureCounter: num });
    return num;
  },

  renumberFigures: (orderedFigureIds) => {
    if (orderedFigureIds.length === 0) {
      set({ figureRegistry: {}, figureCounter: 0 });
      return {};
    }
    const newRegistry: Record<string, number> = {};
    orderedFigureIds.forEach((id, i) => { newRegistry[id] = i + 1; });
    set({ figureRegistry: newRegistry, figureCounter: orderedFigureIds.length });
    return newRegistry;
  },

  removeFigure: (figureId, orderedFigureIds) => {
    const filtered = orderedFigureIds.filter(id => id !== figureId);
    const newRegistry: Record<string, number> = {};
    filtered.forEach((id, i) => { newRegistry[id] = i + 1; });
    set({ figureRegistry: newRegistry, figureCounter: filtered.length });
    return newRegistry;
  },

  resetDocument: () => set({
    title: 'Untitled Manuscript',
    content: DEFAULT_CONTENT,
    saveState: 'Draft',
    citationRegistry: {},
    citationCounter: 0,
    figureRegistry: {},
    figureCounter: 0,
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
          figureRegistry: row.figureRegistry ?? {},
          figureCounter: row.figureCounter ?? 0,
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
    const { title, content, saveState, citationRegistry, citationCounter, figureRegistry, figureCounter } = get();
    const row: DocumentRow = {
      id: 'current',
      title,
      content,
      saveState,
      citationRegistry,
      citationCounter,
      figureRegistry,
      figureCounter,
      updatedAt: Date.now(),
    };
    await db.documents.put(row);
  },
}));
