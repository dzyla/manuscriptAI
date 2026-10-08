import { create } from 'zustand';
import type { JSONContent } from '@tiptap/core';
import { db } from '../db/manuscriptDb';
import { createDexieRepository, type LoadedDocument } from '../db/documentRepository';
import { htmlToDoc, docToHtml, isValidDoc } from '../extensions/schema';
import { migrateLegacyCitations } from '../utils/migrateCitations';
import { createFormat } from '../services/formatPresets';
import type { CommentThread, DocFormat, DocumentMode } from '../types';
import type { ImportResult, HeadingCandidate } from '../docx/read';
import { applyHeadings } from '../docx/read/headings';

export const documentRepository = createDexieRepository(db, { htmlToDoc, isValidDoc, migrateLegacyHtml: migrateLegacyCitations });

interface DocumentState {
  title: string;
  /** Derived HTML (never persisted). Writing it commands the editor; the editor then reports docJson. */
  content: string;
  /** Canonical document, always produced by the editor (onDocChange) or the repository. */
  docJson: JSONContent | null;
  /**
   * Set once per load by initialize(): the canonical document the editor must be fed as JSON
   * (EditorRef.setDocument), so attributes without parseHTML/renderHTML survive. Cleared by whoever applies it.
   */
  pendingDocument: JSONContent | null;
  format: DocFormat;
  comments: CommentThread[];
  lastLoad: { migrated: boolean; recoveredFromBackup: boolean; unreadableRowPresent: boolean; quarantined: boolean };
  /**
   * 'loading' until initialize() finishes; 'failed' if the repository could not be read.
   * persist() writes nothing unless 'ready', so defaults can never overwrite a document we did not load.
   */
  loadStatus: 'loading' | 'ready' | 'failed';
  /**
   * The stored document was unreadable and nothing could be recovered: the editor shows defaults.
   * persist() refuses until an explicit user action replaces the document (New Manuscript /
   * resetDocument, loading a workspace or applying a template → allowOverwrite()).
   */
  blockedByUnreadable: boolean;
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
  /**
   * LOAD-ONLY: record the HTML the editor produced from a document it was just given as JSON, without marking the
   * document as edited. Never use this for a user edit or any content change: it deliberately leaves saveState alone,
   * so an edit routed here would silently stay 'Saved'. Edits go through setContent.
   */
  adoptLoadedHtml: (content: string) => void;
  clearPendingDocument: () => void;
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

  /** Reset to blank document state. An explicit user action: lifts blockedByUnreadable. */
  resetDocument: () => void;

  /** The user explicitly replaced the document (workspace load, template): lift blockedByUnreadable. */
  allowOverwrite: () => void;

  /** Load from Dexie, migrating from localforage if needed. */
  initialize: () => Promise<void>;

  /**
   * Commit a confirmed .docx import and make it the open document. In order: save what is on screen (so the backup of the replaced
   * document holds the latest edits; if that save FAILS the import is not started), apply the headings the author accepted (and only
   * those), write everything in one transaction (`documentRepository.importDocx`), reload the committed document and put it in the
   * store. Autosave is suspended for the whole span: a save queued after the commit would write the replaced document back over the
   * import. Any failure leaves the previous document, in the store and on disk, exactly as it was.
   *
   * Returns the committed document (images resolved to object URLs). The CALLER feeds it to the editor with `EditorRef.setDocument`
   * (which does not record undo history); `pendingDocument` is deliberately not used, because the editor skips a pending document
   * identical to the last one it applied, and re-importing a file after editing the first import would then be silently dropped.
   * Only one import runs at a time.
   */
  importDocx: (result: ImportResult, decisions: { title: string; acceptedHeadings: HeadingCandidate[] }) => Promise<JSONContent>;

  /**
   * Persist current state to Dexie. Resolves true when the state is safely stored (written, or identical
   * to the stored row); false when persistence was refused (not loaded, load failed, or blocked).
   */
  persist: () => Promise<boolean>;
}

/** Save warnings already logged this session (autosave runs every 30 s; log each problem once). */
const reportedWarnings = new Set<string>();

/** True from the start of an import's first save to the end of its commit and reload; `persist` writes nothing meanwhile. */
let importInFlight = false;

const DEFAULT_CONTENT = '<p>Start writing your manuscript here, or click "New Manuscript" to begin with an IMRAD template.</p>';

export const useDocumentStore = create<DocumentState>((set, get) => ({
  title: 'Untitled Manuscript',
  content: DEFAULT_CONTENT,
  docJson: null,
  pendingDocument: null,
  format: createFormat('nih'),
  comments: [],
  lastLoad: { migrated: false, recoveredFromBackup: false, unreadableRowPresent: false, quarantined: false },
  loadStatus: 'loading',
  blockedByUnreadable: false,
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
  adoptLoadedHtml: (content) => set({ content }),
  clearPendingDocument: () => set({ pendingDocument: null }),
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
    pendingDocument: null,
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
    blockedByUnreadable: false,
  }),

  /**
   * The user is explicitly supplying the whole document (workspace load, template apply): lifts the
   * unreadable-document block and also clears a 'failed' load status to 'ready', since there is nothing
   * left to protect from the defaults. A still-'loading' status is left alone (initialize() owns it).
   */
  allowOverwrite: () => set(s => ({ blockedByUnreadable: false, loadStatus: s.loadStatus === 'failed' ? 'ready' : s.loadStatus })),

  initialize: async () => {
    let result: Awaited<ReturnType<typeof documentRepository.load>>;
    try {
      result = await documentRepository.load();
    } catch (err) {
      // Nothing was loaded: never let autosave write defaults over the stored document.
      console.error('DocumentStore.initialize failed:', err);
      set({ loadStatus: 'failed' });
      return;
    }
    const lastLoad = {
      migrated: result.migrated,
      recoveredFromBackup: result.recoveredFromBackup,
      unreadableRowPresent: result.unreadableRowPresent,
      quarantined: result.quarantined,
    };
    try {
      if (result.doc) {
        const d = result.doc;
        // Legacy "[N]" text citations were already turned into citation nodes by the repository's legacy-row
        // conversion (migrateLegacyHtml), before the editor or the stored row ever saw this document, and only
        // for genuinely legacy rows: v3 / DOCX-imported documents are never round-tripped through HTML here.
        const docJson = d.docJson;
        const content = docToHtml(docJson);
        set({
          title: d.title,
          content,
          docJson,
          // The editor is fed this JSON directly; `content` above is only the derived HTML channel.
          pendingDocument: docJson,
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
          lastLoad,
          loadStatus: 'ready',
        });
        return;
      }
      if (result.unreadableRowPresent) {
        // Unreadable row, nothing recovered: the editor shows defaults, which must not be autosaved
        // over the stored row until the user explicitly replaces the document.
        set({ lastLoad, loadStatus: 'ready', blockedByUnreadable: true });
        return;
      }
      set({ lastLoad, loadStatus: 'ready' });

      // Fall back to legacy localforage (pre-Dexie installs)
      const localforage = await import('localforage');
      const data: any = await localforage.default.getItem('manuscript-ai-editor-autosave');
      if (data?.content) {
        const registry: Record<string, number> = data.citationRegistry || {};
        const legacyHtml = migrateLegacyCitations(data.content, registry);
        set({
          title: data.title || 'Untitled Manuscript',
          content: legacyHtml,
          docJson: htmlToDoc(legacyHtml),
          saveState: 'Auto-saved',
          citationRegistry: registry,
          citationCounter: Object.keys(registry).length,
        });
        // Migrate to Dexie immediately; drop the old key only once the copy is written.
        if (await get().persist()) await localforage.default.removeItem('manuscript-ai-editor-autosave');
      }
    } catch (err) {
      console.error('DocumentStore.initialize failed:', err);
      // Failed before the loaded document reached the store: treat as a failed load.
      if (get().loadStatus === 'loading') set({ loadStatus: 'failed' });
    }
  },

  importDocx: async (result, decisions) => {
    if (importInFlight) throw new Error('Another import is already in progress.');
    // While the stored document is still being read, the import and the load would race to set the store: the load can finish second.
    if (get().loadStatus === 'loading') throw new Error('The stored document is still loading. Try again in a moment.');
    importInFlight = true;
    try {
      const s = get();
      if (s.loadStatus === 'ready' && !s.blockedByUnreadable) await persistState(get);
      const doc = applyHeadings(result.doc, decisions.acceptedHeadings);
      await documentRepository.importDocx({ ...result, doc }, { title: decisions.title });
      const loaded = await documentRepository.load();
      if (!loaded.doc) throw new Error('The imported document was stored but could not be read back.');
      const d = loaded.doc;
      set({
        title: d.title,
        content: docToHtml(d.docJson),
        docJson: d.docJson,
        pendingDocument: null,
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
        lastLoad: { migrated: false, recoveredFromBackup: false, unreadableRowPresent: false, quarantined: false },
        // An explicit replacement of the whole document: lifts the unreadable-document block and a failed load.
        blockedByUnreadable: false,
        loadStatus: 'ready',
      });
      return d.docJson;
    } finally {
      importInFlight = false;
    }
  },

  persist: async () => {
    if (importInFlight) return false; // the import owns the document until it is committed and loaded
    return persistState(get);
  },
}));

async function persistState(get: () => DocumentState): Promise<boolean> {
  const s = get();
  if (s.loadStatus !== 'ready' || s.blockedByUnreadable) return false;
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
  const { warnings } = await documentRepository.save(doc);
  for (const w of warnings) {
    if (reportedWarnings.has(w)) continue;
    reportedWarnings.add(w);
    console.warn(w);
  }
  return true;
}
