import { create } from 'zustand';
import type { JSONContent } from '@tiptap/core';
import { db } from '../db/manuscriptDb';
import { createDexieRepository, type LoadedDocument } from '../db/documentRepository';
import { hydrateAssets } from '../db/assetStore';
import { PLACEHOLDER_TEXT } from '../db/placeholder';
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
  /**
   * The .docx import this document is the editable form of (see `DocumentRow.importId`), or null. Set by importDocx / revertImport
   * and by loading a stored document; cleared by every flow that replaces the document with something that is not that import
   * (resetDocument, allowOverwrite). The next persist then detaches the old package instead of leaving it behind.
   */
  importId: string | null;

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

  /**
   * A pasted or duplicated preserved piece got a fresh fragment id (the editor's OpaqueFragmentGuard): remember to store its XML under
   * the new id with the next save of the document that holds it.
   */
  queueFragmentClone: (fromId: string, toId: string) => void;

  /** Reset to blank document state. An explicit user action: lifts blockedByUnreadable. */
  resetDocument: () => void;

  /** The user explicitly replaced the document (workspace load, template): lift blockedByUnreadable. */
  allowOverwrite: () => void;

  /**
   * Replace the whole document with HTML that is NOT the open document's own text: a Version History snapshot, a text file. The
   * document is no longer the editable form of any .docx import, so (like allowOverwrite, which this calls) it ends its tie to the
   * import and the next save detaches the package; and its body is read from `content` until the editor reports its own JSON, rather
   * than the replaced document's JSON being saved under the new text. The caller also gives the HTML to the editor.
   */
  replaceWithHtml: (title: string, content: string) => void;

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
   * Make the document the newest import replaced the open document again (its package and preservation map with it), the same way
   * importDocx makes a document open: save what is on screen, commit in one transaction, reload, set the store, autosave suspended
   * meanwhile. The import it undoes is kept as a backup of the same kind, so calling it again restores that. Returns the document for
   * `EditorRef.setDocument`. Rejects, changing nothing, when there is nothing to restore.
   */
  revertImport: () => Promise<JSONContent>;

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

/** Copies of preserved pieces not yet written with a save (see `queueFragmentClone`). Belong to the open document: dropped when it is replaced. */
let pendingClones: Array<{ fromId: string; toId: string }> = [];

const DEFAULT_CONTENT = `<p>${PLACEHOLDER_TEXT}</p>`;

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
  importId: null,

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

  queueFragmentClone: (fromId, toId) => { pendingClones.push({ fromId, toId }); },

  resetDocument: () => { pendingClones = []; set({
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
    importId: null,
    blockedByUnreadable: false,
  }); },

  /**
   * The user is explicitly supplying the whole document (workspace load, template apply): lifts the
   * unreadable-document block and also clears a 'failed' load status to 'ready', since there is nothing
   * left to protect from the defaults. A still-'loading' status is left alone (initialize() owns it).
   * It also ends the document's tie to a .docx import (`importId`): what the user supplies here is not that import.
   */
  allowOverwrite: () => { pendingClones = []; set(s => ({ blockedByUnreadable: false, importId: null, loadStatus: s.loadStatus === 'failed' ? 'ready' : s.loadStatus })); },

  replaceWithHtml: (title, content) => {
    get().allowOverwrite();
    set({ title, content, docJson: null, pendingDocument: null, saveState: 'Draft' });
  },

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
          importId: d.importId ?? null,
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
    const doc = applyHeadings(result.doc, decisions.acceptedHeadings);
    return replaceOpenDocument(set, get, async () => {
      const { importId } = await documentRepository.importDocx({ ...result, doc }, { title: decisions.title, acceptedHeadingIndexes: decisions.acceptedHeadings.map(h => h.index) });
      return { importId, fallback: { docJson: doc, title: decisions.title.trim() || 'Untitled Manuscript', format: result.format } };
    });
  },

  revertImport: () =>
    replaceOpenDocument(set, get, async () => {
      await documentRepository.revertImport();
      return { importId: null, fallback: null };
    }),

  persist: async () => {
    if (importInFlight) return false; // the import owns the document until it is committed and loaded
    return persistState(get);
  },
}));

type StoreSet = (partial: Partial<DocumentState>) => void;

/**
 * The shared shape of importDocx and revertImport: one document replaces the open one, atomically, and the store follows.
 * `commit` performs the repository transaction and says what it wrote. Autosave is suspended for the whole span, the on-screen
 * document is saved first (so the backup holds the latest edits; if that save fails nothing starts), and any failure BEFORE the
 * commit leaves the store and the disk as they were.
 *
 * After the commit the disk holds the new document, so a failure to read it back must not leave the store on the old one (the next
 * autosave would write the old document over the new row while the new package stays): the store is then set from what was committed.
 */
async function replaceOpenDocument(
  set: StoreSet,
  get: () => DocumentState,
  commit: () => Promise<{ importId: string | null; fallback: { docJson: JSONContent; title: string; format: DocFormat } | null }>,
): Promise<JSONContent> {
  if (importInFlight) throw new Error('Another import is already in progress.');
  // While the stored document is still being read, the import and the load would race to set the store: the load can finish second.
  if (get().loadStatus === 'loading') throw new Error('The stored document is still loading. Try again in a moment.');
  importInFlight = true;
  try {
    const s = get();
    if (s.loadStatus === 'ready' && !s.blockedByUnreadable) await persistState(get);
    const { importId, fallback } = await commit();
    // ---- committed: from here on the store must follow the disk, whatever happens ----
    pendingClones = []; // they belonged to the document that was just replaced
    let loaded: Awaited<ReturnType<typeof documentRepository.load>> | null = null;
    try {
      loaded = await documentRepository.load();
    } catch (err) {
      console.error('The document was committed but could not be read back; using what was committed', err);
    }
    const d = loaded?.doc ?? null;
    if (d && !loaded!.recoveredFromBackup) {
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
        importId: d.importId ?? null,
        lastLoad: { migrated: false, recoveredFromBackup: false, unreadableRowPresent: false, quarantined: false },
        // An explicit replacement of the whole document: lifts the unreadable-document block and a failed load.
        blockedByUnreadable: false,
        loadStatus: 'ready',
      });
      return d.docJson;
    }
    // Read-back failed. Only an import has the document in hand (a restore would have to re-read it): hydrate it here so images show.
    if (!fallback) {
      set({ loadStatus: 'failed' }); // autosave stays off; a reload shows what is on disk
      throw new Error('The previous document was restored but could not be read back. Reload the page to see it.');
    }
    let docJson = fallback.docJson;
    try {
      docJson = await hydrateAssets(fallback.docJson, id => db.assets.get(id));
    } catch {
      // images stay placeholders until the next load; their ids are kept
    }
    set({
      title: fallback.title,
      format: fallback.format,
      content: docToHtml(docJson),
      docJson,
      pendingDocument: null,
      comments: [],
      citationRegistry: {},
      citationCounter: 0,
      figureRegistry: {},
      figureCounter: 0,
      // mode and funder instructions carry over (the store already has them); the template belonged to the replaced document
      grantTemplateId: null,
      importId,
      saveState: 'Saved',
      blockedByUnreadable: false,
      loadStatus: 'ready',
    });
    return docJson;
  } finally {
    importInFlight = false;
  }
}

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
    ...(s.importId ? { importId: s.importId } : {}),
    ...(pendingClones.length ? { fragmentClones: [...pendingClones] } : {}),
  };
  const sent = pendingClones.length;
  const { warnings, written } = await documentRepository.save(doc);
  // Written with the document, in its transaction: forget them (those queued meanwhile stay). A save that wrote nothing keeps them.
  if (written && sent) pendingClones = pendingClones.slice(sent);
  for (const w of warnings) {
    if (reportedWarnings.has(w)) continue;
    reportedWarnings.add(w);
    console.warn(w);
  }
  return true;
}
