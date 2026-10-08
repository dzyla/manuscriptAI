import { Extension, type Editor, type JSONContent } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { flattenDoc, flatSpanToPm } from '../utils/textMatch';
import { auditText } from '../services/proseAudit/metrics';
import type { AuditMetrics, SentenceAudit } from '../types';

export interface StyleHighlightsOptions {
  getEnabled: () => boolean;
  getSentences: () => SentenceAudit[];
  onReport?: (metrics: AuditMetrics) => void;
  debounceMs?: number;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    styleHighlights: {
      /** Rebuild the highlight decorations from the current sentences / enabled state. */
      refreshStyleAudit: () => ReturnType;
      /** Override the enabled option at runtime and rebuild the decorations. */
      setStyleHighlightsEnabled: (on: boolean) => ReturnType;
    };
  }
}

export const styleHighlightsKey = new PluginKey<DecorationSet>('styleHighlights');

/** Severity band drives the tint; the thresholds are the kernel severity scale. */
function severityClass(s: SentenceAudit): string {
  if (s.severity >= 60) return 'style-tell style-tell-high';
  if (s.severity >= 40) return 'style-tell style-tell-mid';
  return 'style-tell style-tell-low';
}

/**
 * Inline decorations for each flagged sentence. Pure: no editor state is changed,
 * and a sentence whose offsets no longer map into the document is skipped.
 */
export function sentenceDecorations(doc: PMNode, sentences: SentenceAudit[]): Decoration[] {
  const flat = flattenDoc(doc);
  const out: Decoration[] = [];
  for (const s of sentences) {
    if (s.start >= flat.text.length) continue;
    const span = flatSpanToPm(flat, s.start, Math.min(s.end, flat.text.length));
    if (!span || span.to <= span.from) continue;
    out.push(
      Decoration.inline(span.from, span.to, {
        class: severityClass(s),
        title: `${s.words} words · ${s.tells.join(', ')}`,
      }),
    );
  }
  return out;
}

export const StyleHighlights = Extension.create<StyleHighlightsOptions, { enabledOverride: boolean | null }>({
  name: 'styleHighlights',

  addOptions() {
    return { getEnabled: () => false, getSentences: () => [], debounceMs: 400 };
  },

  addStorage() {
    return { enabledOverride: null };
  },

  addCommands() {
    return {
      refreshStyleAudit:
        () =>
        ({ dispatch, tr }) => {
          if (dispatch) tr.setMeta(styleHighlightsKey, { refresh: true });
          return true;
        },
      setStyleHighlightsEnabled:
        (on: boolean) =>
        ({ dispatch, tr }) => {
          this.storage.enabledOverride = on;
          if (dispatch) tr.setMeta(styleHighlightsKey, { refresh: true });
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const storage = this.storage;
    const editor = this.editor;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const isEnabled = () => storage.enabledOverride ?? options.getEnabled();

    /** Re-audit off the critical path; the report goes to the host, which feeds sentences back. */
    const scheduleReport = () => {
      if (!options.onReport) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (editor.isDestroyed) return;
        options.onReport?.(auditText(flattenDoc(editor.state.doc).text));
      }, options.debounceMs ?? 400);
    };

    const build = (doc: PMNode) =>
      isEnabled() ? DecorationSet.create(doc, sentenceDecorations(doc, options.getSentences())) : DecorationSet.empty;

    return [
      new Plugin<DecorationSet>({
        key: styleHighlightsKey,
        state: {
          init: (_config, state) => build(state.doc),
          apply(tr, old, _oldState, newState) {
            // An explicit refresh rebuilds from the host's sentences. Plain edits only
            // map the existing decorations: stale offsets are never re-applied to a new doc.
            if (tr.getMeta(styleHighlightsKey)) return build(newState.doc);
            return tr.docChanged ? old.map(tr.mapping, tr.doc) : old;
          },
        },
        props: {
          decorations: state => styleHighlightsKey.getState(state) ?? DecorationSet.empty,
        },
        view: () => ({
          update(view, prevState) {
            if (!view.state.doc.eq(prevState.doc)) scheduleReport();
          },
          destroy() {
            if (timer) clearTimeout(timer);
            timer = null;
          },
        }),
      }),
    ];
  },
});

/**
 * Replace an exact document range with LITERAL text (never parsed as HTML, so
 * `p < 0.05`, `&` and `<control>` survive verbatim). Newlines become hardBreak
 * nodes inside the same block; no new paragraphs are created. Runs as one
 * transaction (one undo step). Returns false, changing nothing, when the range
 * is out of bounds or empty.
 */
export function replaceRangeWithText(editor: Editor, from: number, to: number, text: string): boolean {
  const size = editor.state.doc.content.size;
  if (from < 0 || to > size || to <= from) return false;
  const content: JSONContent[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (i > 0) content.push({ type: 'hardBreak' });
    if (line) content.push({ type: 'text', text: line });
  });
  if (content.length === 0) return false;
  return editor.chain().focus().insertContentAt({ from, to }, content).run();
}
