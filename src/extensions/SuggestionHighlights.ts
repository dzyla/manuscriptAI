import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface SuggestionRange {
  from: number;
  to: number;
  /** A CSS colour (with alpha) for the background. */
  color: string;
}

export const suggestionHighlightsKey = new PluginKey<DecorationSet>('suggestionHighlights');

/**
 * The AI suggestions' background colours, drawn as decorations.
 *
 * They used to be applied as the document's own `highlight` mark. That mark is also what Word's highlighting becomes on import, so
 * clearing the AI's highlights cleared Word's too (a document's highlighting vanished the moment the suggestion list changed, and
 * with it the paragraphs' provenance), and the AI's colours were saved into the document. A decoration is drawn from editor state
 * and never touches the document, its marks or its history; it follows edits through the transaction mapping.
 *
 * Set them with `setSuggestionHighlights(editor.view, ranges)`.
 */
export const SuggestionHighlights = Extension.create({
  name: 'suggestionHighlights',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: suggestionHighlightsKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const ranges = tr.getMeta(suggestionHighlightsKey) as SuggestionRange[] | undefined;
            if (ranges) {
              const size = tr.doc.content.size;
              return DecorationSet.create(
                tr.doc,
                ranges
                  .filter(r => r.from >= 0 && r.to <= size && r.from < r.to)
                  .map(r => Decoration.inline(r.from, r.to, { nodeName: 'mark', style: `background-color: ${r.color};` })),
              );
            }
            return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
          },
        },
        props: {
          decorations: state => suggestionHighlightsKey.getState(state),
        },
      }),
    ];
  },
});

/** Replace the highlighted ranges. A transaction with no steps: the document and its undo history are not touched. */
export function setSuggestionHighlights(view: { state: { tr: import('@tiptap/pm/state').Transaction }; dispatch: (tr: import('@tiptap/pm/state').Transaction) => void }, ranges: SuggestionRange[]): void {
  view.dispatch(view.state.tr.setMeta(suggestionHighlightsKey, ranges).setMeta('addToHistory', false));
}
