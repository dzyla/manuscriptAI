import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor as TipEditor, JSONContent } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/react/menus';
import Placeholder from '@tiptap/extension-placeholder';
import { forwardRef, useImperativeHandle, useEffect, useState, useRef, useCallback } from 'react';
import { Suggestion, ManuscriptSource, SentenceAudit, AuditMetrics } from '../types';
import { GrammarChecker } from '../extensions/GrammarChecker';
import { getSchemaExtensions } from '../extensions/schema';
import { OpaqueFragmentGuard } from '../extensions/preserve/OpaqueNodes';
import { SuggestionHighlights, setSuggestionHighlights, type SuggestionRange } from '../extensions/SuggestionHighlights';
import { generateCompletion } from '../services/ai';
import { AISettings, DocFormat } from '../types';
import { PAGE_SIZES_IN, createFormat } from '../services/formatPresets';
import { estimatePages, contentWidthIn, contentHeightIn } from '../services/pagination';
import { AutoComplete } from '../extensions/AutoComplete';
import { StyleHighlights, replaceRangeWithText, resolveFlatSentence, replaceFlatSentence, type FlatSentenceTarget } from '../extensions/StyleHighlights';
import { sectionText, findHeadingPos, findCitationPos, idsInOrder } from './editor/docQueries';
import { findTextPositionRobust, flattenDoc } from '../utils/textMatch';
import { flatRangeToPm } from './style/styleSync';
import { FigureControls } from './editor/FigureControls';
import { FIGURE_PROMPTS } from './editor/figurePrompts';
import { getImageContext } from './editor/figureContext';
import { TablePicker, TableContextMenu } from './editor/TableMenus';
import { CitationPicker } from './editor/CitationPicker';
import { useCitationPicker } from './editor/useCitationPicker';
import { scrollEditorTo, flashSelection } from './editor/scrollTo';
import { NO_SELECTION, sameSelection, selectionInfo, type SelectionInfo } from './editor/selectionKind';

interface EditorProps {
  content: string;
  onChange: (content: string) => void;
  /** Called with the canonical document after every content change (including external setContent). */
  onDocChange?: (doc: JSONContent) => void;
  /**
   * A freshly loaded canonical document. Applied as JSON (never via HTML) as soon as the editor exists,
   * and the HTML sync effect stands down while it is set. Cleared through onPendingDocumentApplied.
   */
  pendingDocument?: JSONContent | null;
  onPendingDocumentApplied?: () => void;
  /**
   * A pasted or duplicated preserved piece (equation, footnote marker, field chip, comment anchor, tracked change, lifted figure) got a
   * fresh fragment id: the preserved XML stored under `fromId` must also be stored under `toId`, or the copy has nothing to export.
   */
  onDuplicateFragment?: (fromId: string, toId: string) => void;
  /** True once the app has finished loading its stores (so "no pending document" means a fresh install or failed load). */
  loadSettled?: boolean;
  /**
   * Fires exactly once, when the editor exists, loading has settled and no pending document remains: the single,
   * well-defined moment for work that depends on the loaded content (figure renumbering). Fires whether or not a
   * document was loaded.
   */
  onDocumentReady?: () => void;
  /** Receives the editor's own HTML after setDocument without implying a user edit (falls back to onChange). */
  onContentSynced?: (content: string) => void;
  suggestions: Suggestion[];
  onSuggestionClick: (suggestionId: string) => void;
  sources?: ManuscriptSource[];
  citationRegistry?: Record<string, number>;
  onInsertCitation?: (sourceId: string) => number;
  isDistractionFree?: boolean;
  editorZoom?: number;
  editorWidth?: 'normal' | 'wide' | 'full';
  aiSettings?: AISettings;
  /** Tab-triggered AI autocomplete on or off (the AI menu owns the switch). */
  autocompleteEnabled?: boolean;
  onAutocompleteLoading?: (loading: boolean) => void;
  /** The TipTap instance once it exists (null when it goes away): the top bar's selection controls act on it. */
  onEditorReady?: (editor: TipEditor | null) => void;
  /** What is selected, reported whenever the kind, the selected word count or the section changes. */
  onSelectionChange?: (info: SelectionInfo) => void;
  onAnalyzeImage?: (dataUrl: string, prompt: string, contextText?: string) => void;
  /** the document's page format; null/undefined falls back to the NIH preset */
  format?: DocFormat | null;
  /** flagged sentences to tint (sub-project H); empty disables highlighting */
  styleSentences?: SentenceAudit[];
  styleAuditEnabled?: boolean;
  onStyleAudit?: (metrics: AuditMetrics) => void;
}

export interface EditorRef {
  applySuggestion: (originalText: string, suggestedText: string) => boolean;
  revertSuggestion: (originalText: string, suggestedText: string) => boolean;
  scrollToSuggestion: (text: string, id: string) => void;
  getHTML: () => string;
  /** Canonical plain text (block-separated, citation markers included) — use for all LLM calls */
  getPlainText: () => string;
  getJSON: () => Record<string, unknown>;
  setContent: (html: string) => void;
  /** Set the editor from canonical JSON (no HTML round trip) and report it via onDocChange. */
  setDocument: (doc: JSONContent) => void;
  getSelectedText: () => string;
  getCurrentSection: () => string | null;
  getCurrentSectionText: () => string | null;
  getSectionTextByTitle: (title: string) => string | null;
  scrollToHeading: (headingText: string) => void;
  scrollToCitation: (num: number) => void;
  getCitationOrder: () => string[];
  updateCitations: (registry: Record<string, number>) => void;
  getFigureOrder: () => string[];
  updateFigures: (registry: Record<string, number>) => void;
  insertFigureLabelNode: (figureId: string, num: number) => void;
  /** Replace an exact document range with literal text (not HTML; newlines become hard breaks; keeps the block and the range's marks; does not take focus). Returns false for an invalid range or empty text. */
  replaceRange: (from: number, to: number, text: string) => boolean;
  /** Select and scroll to a span given in getPlainText() offsets. False if the span no longer maps into the document. */
  selectFlatRange: (start: number, end: number) => boolean;
  /** Check a sentence (getPlainText() offsets plus the text it must still read) can be rewritten in place. */
  resolveFlatSentence: (start: number, end: number, expected: string) => FlatSentenceTarget;
  /** Replace exactly that sentence in one undoable transaction; the block and its attrs (incl. ooxml) are kept. */
  replaceFlatSentence: (start: number, end: number, expected: string, text: string) => FlatSentenceTarget;
  undo: () => void;
  redo: () => void;
  /** Type an `@` at the caret and open the citation picker, as typing it would. */
  openCitationPicker: () => void;
  /** Open (or close) the table-size grid under `anchor` (a menu button's rectangle). */
  openTablePicker: (anchor?: { left: number; bottom: number }) => void;
  /** Open the system file chooser for an image to insert as a figure. */
  openImagePicker: () => void;
  /** Replace the selected text, keeping the rest; reports the change like a user edit. False with nothing selected. */
  replaceSelection: (text: string) => boolean;
}

// Tiered matcher (exact → normalized → fuzzy) with citation-aware position
// mapping. Tolerates LLM misquotes that the old exact-only search rejected.
const findTextPosition = (doc: any, searchText: string): { from: number; to: number } | null =>
  findTextPositionRobust(doc, searchText);
/** prosemirror-history's plugin key (it does not export it); the same string addresses the plugin and its transaction metadata. */
const HISTORY_PLUGIN_KEY = 'history$';

const DEFAULT_CANVAS_FORMAT: DocFormat = createFormat('nih');


const Editor = forwardRef<EditorRef, EditorProps>(({ content, onChange, onDocChange, pendingDocument, onPendingDocumentApplied, onDuplicateFragment, loadSettled = false, onDocumentReady, onContentSynced, suggestions, onSuggestionClick, sources, citationRegistry, onInsertCitation, isDistractionFree, editorZoom = 100, editorWidth = 'normal', aiSettings, autocompleteEnabled = false, onAutocompleteLoading, onAnalyzeImage, format, styleSentences, styleAuditEnabled, onStyleAudit, onEditorReady, onSelectionChange }, ref) => {
  const [isMounted, setIsMounted] = useState(false);
  const canvasFormat = format ?? DEFAULT_CANVAS_FORMAT;

  const pageGuideContainerRef = useRef<HTMLDivElement>(null);
  const [pageGuideOffsets, setPageGuideOffsets] = useState<number[]>([]);
  const fitRef = useRef<HTMLDivElement>(null);
  // Fit-to-width: the zoom actually applied, never above what the user asked for.
  const [effectiveZoom, setEffectiveZoom] = useState(editorZoom / 100);
  const onDocChangeRef = useRef(onDocChange);
  useEffect(() => { onDocChangeRef.current = onDocChange; }, [onDocChange]);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  const onContentSyncedRef = useRef(onContentSynced);
  useEffect(() => { onContentSyncedRef.current = onContentSynced; }, [onContentSynced]);
  /**
   * Number of programmatic content applications whose onUpdate echo must not be reported as a user edit.
   * A counter (not a boolean) so overlapping applies cannot unmask each other: each releases only its own hold.
   */
  const externalUpdateHolds = useRef(0);
  const holdExternalUpdate = () => {
    externalUpdateHolds.current++;
    setTimeout(() => { externalUpdateHolds.current--; }, 0);
  };
  const lastExternalContent = useRef(content);
  const [showTablePicker, setShowTablePicker] = useState(false);
  const [tablePickerPos, setTablePickerPos] = useState<{ x: number; y: number } | null>(null);
  const [tableHover, setTableHover] = useState<{ rows: number; cols: number }>({ rows: 0, cols: 0 });
  const [tableContextMenu, setTableContextMenu] = useState<{ x: number; y: number } | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const autocompleteEnabledRef = useRef(false);
  const onAutocompleteLoadingRef = useRef(onAutocompleteLoading);
  onAutocompleteLoadingRef.current = onAutocompleteLoading;
  const aiSettingsRef = useRef<AISettings | undefined>(aiSettings);
  const onDuplicateFragmentRef = useRef(onDuplicateFragment);
  onDuplicateFragmentRef.current = onDuplicateFragment;
  // What is selected, reported upward only when it changes. The position of a selected figure keys its controls, so another figure starts them afresh.
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const lastSelection = useRef<SelectionInfo>(NO_SELECTION);
  const [figure, setFigure] = useState<{ at: number; align: string | null } | null>(null);
  const reportSelection = (e: TipEditor) => {
    const info = selectionInfo(e);
    const next = info.kind === 'figure' ? { at: e.state.selection.from, align: e.getAttributes('resizableImage').align ?? null } : null;
    setFigure(prev => (prev?.at === next?.at && prev?.align === next?.align ? prev : next));
    if (sameSelection(info, lastSelection.current)) return;
    lastSelection.current = info;
    onSelectionChangeRef.current?.(info);
  };

  useEffect(() => { setIsMounted(true); }, []);

  useEffect(() => { aiSettingsRef.current = aiSettings; }, [aiSettings]);
  useEffect(() => { autocompleteEnabledRef.current = autocompleteEnabled; }, [autocompleteEnabled]);


  const styleSentencesRef = useRef<SentenceAudit[]>(styleSentences ?? []);
  const styleAuditEnabledRef = useRef(!!styleAuditEnabled);
  const onStyleAuditRef = useRef(onStyleAudit);

  const editor = useEditor({
    extensions: [
      ...getSchemaExtensions(),
      OpaqueFragmentGuard.configure({ onDuplicateFragment: (fromId, toId) => onDuplicateFragmentRef.current?.(fromId, toId) }),
      SuggestionHighlights,
      Placeholder.configure({ placeholder: 'Start writing your manuscript here...' }),
      GrammarChecker,
      AutoComplete.configure({
        getEnabled: () => autocompleteEnabledRef.current,
        onSuggest: (contextText, signal, meta) => {
          if (!aiSettingsRef.current) return Promise.resolve('');
          return generateCompletion(contextText, aiSettingsRef.current, signal, meta?.heading);
        },
        onLoadingChange: (loading) => onAutocompleteLoadingRef.current?.(loading),
      }),
      StyleHighlights.configure({
        getEnabled: () => styleAuditEnabledRef.current,
        getSentences: () => styleSentencesRef.current,
        onReport: (m) => onStyleAuditRef.current?.(m),
      }),
    ],
    content,
    onCreate: ({ editor }) => { onDocChangeRef.current?.(editor.getJSON()); },
    onUpdate: ({ editor }) => {
      onDocChangeRef.current?.(editor.getJSON());
      if (externalUpdateHolds.current > 0) return;
      const html = editor.getHTML();
      lastExternalContent.current = html;
      onChangeRef.current(html);
    },
    onTransaction: ({ editor }) => reportSelection(editor),

    editorProps: {
      attributes: { class: 'prose max-w-none focus:outline-none min-h-[500px]' },
    },
  });

  useEffect(() => { styleSentencesRef.current = styleSentences ?? []; editor?.commands.refreshStyleAudit(); }, [styleSentences, editor]);
  useEffect(() => { styleAuditEnabledRef.current = !!styleAuditEnabled; editor?.commands.refreshStyleAudit(); }, [styleAuditEnabled, editor]);
  useEffect(() => { onStyleAuditRef.current = onStyleAudit; }, [onStyleAudit]);

  // ── Fit to width: effective zoom = min(user zoom, available / page width) ──
  // Still the single CSS `zoom` on the canvas, so the guides stay in the same
  // coordinate frame as the text by construction.
  useEffect(() => {
    const wrap = fitRef.current;
    const avail = wrap?.parentElement;
    const requested = editorZoom / 100;
    const pageWidthPx = PAGE_SIZES_IN[canvasFormat.page.size].width * 96;
    const fit = () => {
      const cs = avail ? getComputedStyle(avail) : null;
      const pad = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 0;
      const width = avail ? avail.clientWidth - pad : 0;
      // 0 means unmeasured (no layout): leave the user's zoom alone.
      setEffectiveZoom(width > 0 ? Math.max(0.1, Math.min(requested, width / pageWidthPx)) : requested);
    };
    fit();
    if (typeof ResizeObserver === 'undefined' || !avail) return;
    const ro = new ResizeObserver(fit);
    ro.observe(avail);
    return () => ro.disconnect();
  }, [editorZoom, canvasFormat.page.size]);

  // ── Page guides ──────────────────────────────────────────────────────────
  // HOW MANY guides, and their "p. N" labels, come from estimatePages (the one
  // page-number source). WHERE each sits is DOM-measured: the page pitch is the
  // rendered content width scaled by the format's page shape. Zoom-invariant,
  // since measurement and guides share the zoomed canvas's coordinate frame.
  useEffect(() => {
    const el = pageGuideContainerRef.current;
    if (!el) return;
    const compute = () => {
      const prose = el.querySelector('.ProseMirror') as HTMLElement | null;
      if (!prose) return;
      const widthIn = contentWidthIn(format ?? null);
      if (widthIn <= 0) return;
      const pageHeight = (prose.clientWidth / widthIn) * contentHeightIn(format ?? null);
      if (pageHeight < 100) { setPageGuideOffsets([]); return; }
      const n = estimatePages(editor?.getJSON(), format ?? null).pages - 1;
      const contentTop = prose.offsetTop;
      setPageGuideOffsets(Array.from({ length: Math.min(n, 200) }, (_, i) => contentTop + (i + 1) * pageHeight));
    };
    compute();
    // Absent in jsdom and very old webviews; the guides then just measure once per content change.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(compute);
    const prose = el.querySelector('.ProseMirror');
    if (prose) ro.observe(prose);
    return () => ro.disconnect();
  }, [format, content, editor, effectiveZoom]);

  // Handle clicks on highlight marks: find suggestion by ProseMirror position (TipTap Highlight
  // doesn't render custom attributes to DOM, so we can't use data-suggestion-id on the element)
  useEffect(() => {
    if (!editor) return;
    const editorEl = editor.view.dom;

    const handleDomClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName !== 'MARK') return;
      const resolved = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (!resolved) return;
      const pos = resolved.pos;
      for (const s of suggestions) {
        const match = findTextPosition(editor.state.doc, s.originalText);
        if (match && pos >= match.from && pos <= match.to) {
          onSuggestionClick(s.id);
          return;
        }
      }
    };

    editorEl.addEventListener('click', handleDomClick);
    return () => editorEl.removeEventListener('click', handleDomClick);
  }, [editor, suggestions, onSuggestionClick]);

  const citation = useCitationPicker({ editor, sources, onInsertCitation });
  useEffect(() => { onEditorReady?.(editor); return () => onEditorReady?.(null); }, [editor, onEditorReady]);

  // Close table picker on click outside
  useEffect(() => {
    if (!showTablePicker) return;
    const handler = (e: MouseEvent) => {
      const picker = document.getElementById('table-picker-portal');
      if (picker && !picker.contains(e.target as Node)) setShowTablePicker(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showTablePicker]);


  // Right-click context menu for table editing
  useEffect(() => {
    if (!editor) return;
    const editorEl = editor.view.dom;
    const handleContextMenu = (e: MouseEvent) => {
      if (!editor.isActive('tableCell') && !editor.isActive('tableHeader')) return;
      e.preventDefault();
      setTableContextMenu({ x: e.clientX, y: e.clientY });
    };
    const handleMouseDown = (e: MouseEvent) => {
      if (tableContextMenu) {
        const menu = document.getElementById('table-context-menu');
        if (menu && !menu.contains(e.target as Node)) setTableContextMenu(null);
      }
    };
    editorEl.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      editorEl.removeEventListener('contextmenu', handleContextMenu);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [editor, tableContextMenu]);

  const openTablePicker = (anchor?: { left: number; bottom: number }) => {
    if (showTablePicker) { setShowTablePicker(false); return; }
    setTablePickerPos({ x: anchor?.left ?? 24, y: (anchor?.bottom ?? 48) + 4 });
    setShowTablePicker(true);
  };

  const insertTable = (rows: number, cols: number) => {
    if (!editor) return;
    setShowTablePicker(false);
    setTableHover({ rows: 0, cols: 0 });
    // Delay to let picker close and allow editor to be ready
    setTimeout(() => {
      if (editor.isDestroyed) return;
      editor.commands.focus();
      editor.commands.insertTable({ rows, cols, withHeaderRow: true });
    }, 50);
  };

  const insertImageFromFile = async (file: File) => {
    if (!editor) return;
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    bytes.forEach(b => { binary += String.fromCharCode(b); });
    const base64 = btoa(binary);
    const dataUrl = `data:${file.type};base64,${base64}`;
    (editor.chain().focus() as any).insertResizableImage({ src: dataUrl, alt: file.name, width: '100%', align: 'center' }).run();
  };

  /**
   * Set the editor from canonical JSON. The store's derived HTML `content` is also written from the editor's own
   * output, so the "sync content from parent" effect below sees content === lastExternalContent and does not
   * re-apply (lossily, through HTML) what we just set.
   */
  const applyDocument = useCallback((doc: JSONContent) => {
    if (!editor) return;
    holdExternalUpdate();
    // Loading a document is not an edit: it must not be undoable (Ctrl+Z right after a load, or after a .docx import, would
    // otherwise bring back the document it replaced, or an empty one) and the edits made to the PREVIOUS document must not stay
    // on the undo stack, where undoing them would splice their text into this one. Marking the transaction `addToHistory: false`
    // is not enough for the second part (the history would only re-map the old entries), so the history state is also replaced
    // with a fresh, empty one.
    editor.chain().command(({ tr, state }) => {
      tr.setMeta('addToHistory', false);
      const history = state.plugins.find(p => (p as unknown as { key: string }).key === HISTORY_PLUGIN_KEY);
      const init = (history?.spec as unknown as { state?: { init?: () => unknown } } | undefined)?.state?.init;
      const fresh = init?.();
      if (fresh) tr.setMeta(HISTORY_PLUGIN_KEY, { historyState: fresh });
      return true;
    }).setContent(doc).run();
    const html = editor.getHTML();
    lastExternalContent.current = html;
    onDocChangeRef.current?.(editor.getJSON());
    (onContentSyncedRef.current ?? onChangeRef.current)(html);
  }, [editor]);

  // Feed a freshly loaded document as JSON (runs before the content sync below, which stands down meanwhile).
  const lastPendingAppliedRef = useRef<{ editor: unknown; json: string } | null>(null);
  useEffect(() => {
    if (!editor || !pendingDocument) return;
    // Dev StrictMode runs the app's init effect (and so initialize()) twice, delivering an identical document
    // twice: apply a given document to a given editor once.
    const json = JSON.stringify(pendingDocument);
    const last = lastPendingAppliedRef.current;
    if (!last || last.editor !== editor || last.json !== json) {
      lastPendingAppliedRef.current = { editor, json };
      applyDocument(pendingDocument);
    }
    onPendingDocumentApplied?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, pendingDocument, applyDocument]);

  // Sync content from parent
  useEffect(() => {
    if (!editor) return;
    // The JSON path owns this load. This effect depends on pendingDocument so that it re-runs when the flag clears:
    // a content write that arrived meanwhile is then applied (or is a no-op, as applyDocument already made
    // content === lastExternalContent on the normal path) instead of being dropped.
    if (pendingDocument) return;
    if (content !== lastExternalContent.current) {
      holdExternalUpdate();
      editor.commands.setContent(content);
      onDocChangeRef.current?.(editor.getJSON());
      lastExternalContent.current = content;
    }
  }, [content, editor, pendingDocument]);

  // Declared after the content sync effect on purpose: in a commit that does both, content is applied first.
  const documentReadyFiredRef = useRef(false);
  useEffect(() => {
    if (!editor || !loadSettled || pendingDocument || documentReadyFiredRef.current) return;
    documentReadyFiredRef.current = true;
    onDocumentReady?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, loadSettled, pendingDocument]);

  // Draw the suggestions' highlighting. These are decorations (SuggestionHighlights), not marks: the document's own highlight mark is
  // Word's highlighting once a .docx is imported, and this effect runs on every new suggestions array (e.g. when an import clears them).
  useEffect(() => {
    if (!editor) return;
    const ranges: SuggestionRange[] = [];
    suggestions.forEach(s => {
      const color = s.agent === 'manager' ? '#1c1917' :
                    s.agent === 'editor' ? '#3b6fd4' :
                    s.agent === 'reviewer-2' ? '#c43d5c' :
                    s.agent === 'researcher' ? '#b8860b' : '#8a847a';
      const posMatch = findTextPosition(editor.state.doc, s.originalText);
      if (posMatch) ranges.push({ from: posMatch.from, to: posMatch.to, color: `${color}25` });
    });
    setSuggestionHighlights(editor.view, ranges);
  }, [suggestions, editor]);

  const getSelectedText = () => {
    if (!editor) return '';
    const { from, to } = editor.state.selection;
    return editor.state.doc.textBetween(from, to, ' ');
  };

  const getSectionText = (sectionTitle: string): string => (editor ? sectionText(editor.state.doc, sectionTitle) : sectionTitle);

  useImperativeHandle(ref, () => ({
    replaceRange: (from: number, to: number, text: string) => (editor ? replaceRangeWithText(editor, from, to, text) : false),
    resolveFlatSentence: (start, end, expected) => (editor ? resolveFlatSentence(editor, start, end, expected) : { ok: false, reason: 'unmappable' }),
    replaceFlatSentence: (start, end, expected, text) => (editor ? replaceFlatSentence(editor, start, end, expected, text) : { ok: false, reason: 'unmappable' }),
    selectFlatRange: (start: number, end: number) => {
      if (!editor) return false;
      const span = flatRangeToPm(editor.state.doc, start, end);
      if (!span) return false;
      editor.chain().focus().setTextSelection({ from: span.from, to: span.to }).scrollIntoView().run();
      return true;
    },
    applySuggestion: (originalText, suggestedText) => {
      if (!editor) return false;
      const posMatch = findTextPosition(editor.state.doc, originalText);
      if (!posMatch) return false;

      // Apply synchronously so callers reading getHTML() right after see the
      // new content (history recording and accept-all depend on this).
      editor.chain().focus()
        .setTextSelection({ from: posMatch.from, to: posMatch.to })
        .insertContent(suggestedText)
        .scrollIntoView()
        .run();

      const newHtml = editor.getHTML();
      lastExternalContent.current = newHtml;
      onChange(newHtml);

      flashSelection(); // cosmetic

      return true;
    },
    revertSuggestion: (originalText, suggestedText) => {
      if (!editor) return false;
      const posMatch = findTextPosition(editor.state.doc, suggestedText);
      if (posMatch) {
        editor.chain().focus()
          .setTextSelection({ from: posMatch.from, to: posMatch.to })
          .insertContent(originalText)
          .run();
        const newHtml = editor.getHTML();
        lastExternalContent.current = newHtml;
        onChange(newHtml);
        return true;
      }
      return false;
    },
    scrollToSuggestion: (text) => {
      if (!editor) return;
      const posMatch = findTextPosition(editor.state.doc, text);
      if (posMatch) {
        // Set selection and scroll into view
        editor.chain().focus()
          .setTextSelection({ from: posMatch.from, to: posMatch.to })
          .scrollIntoView()
          .run();

        // ProseMirror's own scrollIntoView ran above; this centres it in the scroll container (and survives an unmount).
        scrollEditorTo(editor, posMatch.from);
      }
    },
    getHTML: () => editor?.getHTML() || '',
    getPlainText: () => editor ? flattenDoc(editor.state.doc).text : '',
    getJSON: () => editor?.getJSON() ?? { type: 'doc', content: [] },
    setContent: (html: string) => {
      if (!editor) return;
      holdExternalUpdate();
      editor.commands.setContent(html);
      onDocChangeRef.current?.(editor.getJSON());
      lastExternalContent.current = html;
    },
    setDocument: (doc: JSONContent) => applyDocument(doc),
    getSelectedText,
    getCurrentSection: () => selectionInfo(editor).section,
    getCurrentSectionText: () => { const s = selectionInfo(editor).section; return s ? getSectionText(s) : null; },
    getSectionTextByTitle: (title: string) => title ? getSectionText(title) : null,
    scrollToHeading: (headingText: string) => {
      if (!editor) return;
      const pos = findHeadingPos(editor.state.doc, headingText);
      if (pos === null) return;
      editor.chain().focus().setTextSelection(pos + 1).scrollIntoView().run();
      scrollEditorTo(editor, pos + 1, 'top');
    },
    scrollToCitation: (num: number) => {
      if (!editor) return;
      const pos = findCitationPos(editor.state.doc, num);
      if (pos === null) return;
      editor.chain().focus().setTextSelection(pos).scrollIntoView().run();
      scrollEditorTo(editor, pos);
    },
    getCitationOrder: () => (editor ? idsInOrder(editor.state.doc, 'citation') : []),
    updateCitations: (registry: Record<string, number>) => {
      if (!editor) return;
      editor.commands.updateAllCitationNums(registry);
    },
    getFigureOrder: () => (editor ? idsInOrder(editor.state.doc, 'figureLabel') : []),
    updateFigures: (registry: Record<string, number>) => {
      if (!editor) return;
      editor.commands.updateAllFigureNums(registry);
    },
    insertFigureLabelNode: (figureId: string, num: number) => {
      if (!editor) return;
      editor.chain().focus().insertFigureLabel(figureId, num).run();
    },
    undo: () => { editor?.chain().focus().undo().run(); },
    redo: () => { editor?.chain().focus().redo().run(); },
    openCitationPicker: citation.open,
    openTablePicker,
    openImagePicker: () => imageInputRef.current?.click(),
    replaceSelection: (text: string) => {
      if (!editor) return false;
      const { from, to } = editor.state.selection;
      if (from === to) return false;
      editor.chain().focus().setTextSelection({ from, to }).insertContent(text).run();
      onChange(editor.getHTML());
      return true;
    },
  }));

  if (!editor) return null;

  const widthClass = editorWidth === 'wide' ? 'max-w-6xl' : editorWidth === 'full' ? 'max-w-none' : 'max-w-4xl';
  const analyzeFigure = (prompt: string, withContext = true) => {
    const attrs = editor.getAttributes('resizableImage');
    if (!attrs.src || !onAnalyzeImage) return;
    onAnalyzeImage(attrs.src, prompt, withContext ? getImageContext(editor) : undefined);
  };

  return (
    <div className={`w-full ${widthClass} mx-auto ${isDistractionFree ? 'focus-mode' : ''}`}>
      <div className="bg-[var(--editor-bg)] min-h-[600px] shadow-[var(--editor-shadow)] rounded-sm border border-[var(--border-subtle)] transition-colors duration-300">
        <input
          ref={imageInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0];
            if (file) { insertImageFromFile(file); e.target.value = ''; }
          }}
        />
        <div ref={fitRef}>
        <div
          ref={pageGuideContainerRef}
          data-testid="page-canvas"
          className="page-canvas relative mx-auto"
          style={{
            width: `${PAGE_SIZES_IN[canvasFormat.page.size].width}in`,
            minHeight: `${PAGE_SIZES_IN[canvasFormat.page.size].height}in`,
            paddingTop: `${canvasFormat.page.marginsIn.top}in`,
            paddingRight: `${canvasFormat.page.marginsIn.right}in`,
            paddingBottom: `${canvasFormat.page.marginsIn.bottom}in`,
            paddingLeft: `${canvasFormat.page.marginsIn.left}in`,
            fontFamily: canvasFormat.defaults.fontFamily,
            fontSize: `${canvasFormat.defaults.fontSizePt}pt`,
            zoom: effectiveZoom,
          }}
        >
          <div data-testid="page-guides" aria-hidden className="absolute inset-0 pointer-events-none">
          {pageGuideOffsets.map((top, i) => (
            <div key={i} className="absolute left-0 right-0 pointer-events-none z-10" style={{ top }} aria-hidden>
              <div className="border-t border-dashed border-stone-300 relative">
                <span className="absolute -top-2.5 right-1 text-[9px] font-bold px-1 rounded" style={{ color: 'var(--text-muted)', background: 'var(--surface-1)' }}>
                  p. {i + 2}
                </span>
              </div>
            </div>
          ))}
          </div>
          <EditorContent editor={editor} />
        </div>
        </div>

      </div>

      {/* Figure controls float on the selected figure (or on a selection that spans one), and nowhere else. */}
      <BubbleMenu
        editor={editor}
        shouldShow={({ editor: e, from, to }) => {
          if (e.isActive('resizableImage')) return true;
          let hasImg = false;
          e.state.doc.nodesBetween(from, to, n => { if (n.type.name === 'resizableImage') { hasImg = true; return false; } return true; });
          return hasImg;
        }}
        options={{ placement: 'top', offset: 8 }}
      >
        <FigureControls
          key={figure?.at ?? 'none'}
          align={(figure?.align as 'left' | 'center' | 'right' | null) ?? null}
          context={getImageContext(editor)}
          onAlign={a => { editor.commands.updateAttributes('resizableImage', { align: a }); }}
          onSize={w => { editor.commands.updateAttributes('resizableImage', { width: w }); }}
          onDelete={() => { editor.chain().focus().deleteSelection().run(); }}
          onDescribe={() => analyzeFigure(FIGURE_PROMPTS.describe)}
          onQuality={() => analyzeFigure(FIGURE_PROMPTS.quality)}
          onRelevance={() => analyzeFigure(FIGURE_PROMPTS.relevance)}
          onAsk={q => analyzeFigure(q)}
        />
      </BubbleMenu>

      {showTablePicker && tablePickerPos && (
        <TablePicker pos={tablePickerPos} hover={tableHover} onHover={setTableHover} onPick={insertTable} />
      )}
      {tableContextMenu && <TableContextMenu editor={editor} pos={tableContextMenu} onDone={() => setTableContextMenu(null)} />}

      {citation.at && isMounted && (
        <CitationPicker
          at={citation.at}
          filter={citation.filter}
          sources={citation.filtered}
          registry={citationRegistry}
          doiState={citation.doiState}
          doiError={citation.doiError}
          onChooseSource={citation.chooseSource}
          onLookupDoi={citation.lookupDoi}
          onLookupDois={citation.lookupDois}
          onDismissError={citation.dismissError}
        />
      )}
    </div>
  );
});

export default Editor;
