import { create } from 'zustand';
import type { JSONContent } from '@tiptap/core';
import { db } from '../db/manuscriptDb';
import { createDexieRepository, type LoadedDocument } from '../db/documentRepository';
import { htmlToDoc, docToHtml, isValidDoc } from '../extensions/schema';
import { createFormat } from '../services/formatPresets';
import type { CommentThread, DocFormat, DocumentMode } from '../types';

export const documentRepository = createDexieRepository(db, { htmlToDoc, isValidDoc });

interface DocumentState {
  title: string;
  /** Derived HTML (never persisted). Writing it commands the editor; the editor then reports docJson. */
  content: string;
  /** Canonical document, always produced by the editor (onDocChange) or the repository. */
  docJson: JSONContent | null;
  format: DocFormat;
  comments: CommentThread[];
  lastLoad: { migrated: boolean; recoveredFromBackup: boolean; unreadableRowPresent: boolean };
  saveState: 'Draft' | 'Saved' | 'Auto-saved';
  citationRegistry: Record<string, number>;
  citationCounter: number;
  figureRegistry: Record<string, number>;
  figureCounter: number;
  mode: DocumentMode;
  grantInstructions: string;
  grantTemplateId: string | null;

  setTitle: (title: string) => void;
  setDocJson: (doc: JSONContent) => void;
  setFormat: (format: DocFormat) => void;
  setComments: (comments: CommentThread[]) => void;
  setContent: (content: string) => void;
  setSaveState: (s: DocumentState['saveState']) => void;
  setCitationRegistry: (reg: Record<string, number>) => void;
  setMode: (mode: DocumentMode) => void;
  setGrantInstructions: (text: string) => void;
  setGrantTemplateId: (id: string | null) => void;

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
  docJson: null,
  format: createFormat('nih'),
  comments: [],
  lastLoad: { migrated: false, recoveredFromBackup: false, unreadableRowPresent: false },
  saveState: 'Draft',
  citationRegistry: {},
  citationCounter: 0,
  figureRegistry: {},
  figureCounter: 0,
  mode: 'manuscript',
  grantInstructions: '',
  grantTemplateId: null,

  setDocJson: (docJson) => set({ docJson }),
  setFormat: (format) => set({ format, saveState: 'Draft' }),
  setComments: (comments) => set({ comments, saveState: 'Draft' }),
  setTitle: (title) => set({ title, saveState: 'Draft' }),
  setContent: (content) => set({ content, saveState: 'Draft' }),
  setSaveState: (saveState) => set({ saveState }),
  setCitationRegistry: (citationRegistry) => set({ citationRegistry }),
  setMode: (mode) => set({ mode, saveState: 'Draft' }),
  setGrantInstructions: (grantInstructions) => set({ grantInstructions, saveState: 'Draft' }),
  setGrantTemplateId: (grantTemplateId) => set({ grantTemplateId, saveState: 'Draft' }),

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
    docJson: null,
    format: createFormat('nih'),
    comments: [],
    saveState: 'Draft',
    citationRegistry: {},
    citationCounter: 0,
    figureRegistry: {},
    figureCounter: 0,
    mode: 'manuscript',
    grantInstructions: '',
    grantTemplateId: null,
  }),

  initialize: async () => {
    try {
      const result = await documentRepository.load();
      if (result.doc) {
        const d = result.doc;
        set({
          title: d.title,
          content: docToHtml(d.docJson),
          docJson: d.docJson,
          format: d.format,
          comments: d.comments,
          saveState: d.saveState,
          citationRegistry: d.citationRegistry,
          citationCounter: d.citationCounter,
          figureRegistry: d.figureRegistry,
          figureCounter: d.figureCounter,
          mode: d.mode,
          grantInstructions: d.grantInstructions,
          grantTemplateId: d.grantTemplateId,
          lastLoad: {
            migrated: result.migrated,
            recoveredFromBackup: result.recoveredFromBackup,
            unreadableRowPresent: result.unreadableRowPresent,
          },
        });
        return;
      }
      set({
        lastLoad: {
          migrated: false,
          recoveredFromBackup: result.recoveredFromBackup,
          unreadableRowPresent: result.unreadableRowPresent,
        },
      });

      // Fall back to legacy localforage (pre-Dexie installs)
      const localforage = await import('localforage');
      const data: any = await localforage.default.getItem('manuscript-ai-editor-autosave');
      if (data?.content) {
        const registry: Record<string, number> = data.citationRegistry || {};
        set({
          title: data.title || 'Untitled Manuscript',
          content: data.content,
          docJson: htmlToDoc(data.content),
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
    const s = get();
    const doc: LoadedDocument = {
      title: s.title,
      saveState: s.saveState,
      docJson: s.docJson ?? htmlToDoc(s.content),
      format: s.format,
      comments: s.comments,
      citationRegistry: s.citationRegistry,
      citationCounter: s.citationCounter,
      figureRegistry: s.figureRegistry,
      figureCounter: s.figureCounter,
      mode: s.mode,
      grantInstructions: s.grantInstructions,
      grantTemplateId: s.grantTemplateId,
    };
    await documentRepository.save(doc);
  },
}));
