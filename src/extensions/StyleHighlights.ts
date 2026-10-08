import { Extension, type Editor, type JSONContent } from '@tiptap/core';
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
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
      /**
       * Override the enabled option at runtime and rebuild the decorations. The override is
       * sticky: once set it shadows `options.getEnabled()` for the life of the editor.
       */
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
          if (dispatch) {
            this.storage.enabledOverride = on;
            tr.setMeta(styleHighlightsKey, { refresh: true });
          }
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

    /**
     * Re-audit off the critical path; the report goes to the host, which feeds sentences back.
     * Only runs while highlighting is enabled, so users who never open the style feature pay nothing.
     * The host must enable highlighting (or call setStyleHighlightsEnabled) to receive reports.
     */
    const scheduleReport = () => {
      if (!options.onReport || !isEnabled()) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (editor.isDestroyed) return;
        try {
          options.onReport?.(auditText(flattenDoc(editor.state.doc).text));
        } catch (err) {
          console.error('Style audit failed', err);
        }
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
 * Replace an exact document range with LITERAL text, never parsed as HTML
 * (`p < 0.05`, `&amp;` and `<b>` survive verbatim).
 *
 * - Newlines (`\n`, `\r\n`, lone `\r`) become hardBreak nodes inside the same
 *   block; no paragraphs are created.
 * - The fragment is built here and applied with `tr.replaceWith`, not through
 *   `insertContentAt`: that command shifts the start back by one at offset 0 of a
 *   textblock when the content has a non-text node, which would swap the block
 *   (heading -> paragraph) and drop its attrs (textAlign, ooxml). One code path is
 *   used for single- and multi-line text so both behave identically.
 * - The inserted text carries the marks of the replaced range: `marksAcross` takes the
 *   marks of the first run in the range (bold-then-italic yields bold), matching TipTap's
 *   own `insertText`.
 * - The range must lie inside the inline content of ONE block (same parent at both ends, and
 *   that parent holds inline content, so doc-level / between-sibling ranges are rejected); a range crossing a block
 *   boundary (e.g. stale offsets) is rejected rather than merging blocks.
 * - Multi-line text is rejected when the target block cannot hold a hardBreak (e.g. a code
 *   block); single-line text is still allowed there.
 * - One transaction, so one undo step. It does not move focus; the caller decides.
 * - Returns false and changes nothing for a non-integer, out-of-bounds, empty or cross-block
 *   range, for multi-line text the block cannot hold, and for empty text (so this cannot be used to delete a range).
 */
export function replaceRangeWithText(editor: Editor, from: number, to: number, text: string): boolean {
  const size = editor.state.doc.content.size;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
  if (from < 0 || to > size || to <= from) return false;
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.every(l => l === '')) return false;
  // All guards run on the current state BEFORE any command, so a rejected call dispatches
  // nothing at all (TipTap would otherwise dispatch an empty transaction, letting
  // appendTransaction plugins such as the trailing-node one touch the document).
  const doc0 = editor.state.doc;
  const schema = doc0.type.schema;
  const $from0 = doc0.resolve(from);
  const $to0 = doc0.resolve(to);
  if (!$from0.sameParent($to0) || !$from0.parent.inlineContent) return false;
  if (lines.length > 1 && !$from0.parent.canReplaceWith($from0.index(), $to0.index(), schema.nodes.hardBreak)) return false;
  return editor.commands.command(({ tr, dispatch }) => {
    const { doc } = tr;
    const marks = doc.resolve(from).marksAcross(doc.resolve(to)) ?? [];
    const nodes: PMNode[] = [];
    lines.forEach((line, i) => {
      if (i > 0) nodes.push(schema.nodes.hardBreak.create(null, null, marks.filter(m => schema.nodes.hardBreak.allowsMarkType(m.type))));
      if (line) nodes.push(schema.text(line, marks));
    });
    const fragment = Fragment.from(nodes);
    try {
      tr.replaceWith(from, to, fragment);
    } catch {
      return false;
    }
    if (dispatch) {
      const end = tr.mapping.map(from, -1) + fragment.size;
      tr.setSelection(Selection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size)), -1));
    }
    return true;
  });
}
