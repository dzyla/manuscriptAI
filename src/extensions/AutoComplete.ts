import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface AutoCompleteOptions {
  /** Reads a live ref — returns true when the feature is toggled on */
  getEnabled: () => boolean;
  /** Called with text before cursor + abort signal; resolves to the completion string */
  onSuggest: (contextText: string, signal: AbortSignal) => Promise<string>;
  /** Notifies Editor when a request is in-flight so a spinner can show */
  onLoadingChange?: (loading: boolean) => void;
}

interface ACState {
  suggestion: string;
}

export const autocompleteKey = new PluginKey<ACState>('autoComplete');

export const AutoComplete = Extension.create<AutoCompleteOptions>({
  name: 'autoComplete',

  addOptions() {
    return {
      getEnabled: () => false,
      onSuggest: async () => '',
      onLoadingChange: undefined,
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let abortCtrl: AbortController | null = null;

    const triggerCompletion = async (view: any) => {
      if (!options.getEnabled()) return;

      const { from, to } = view.state.selection;
      if (from !== to) return; // no completion when text is selected

      const contextStart = Math.max(0, from - 800);
      const contextText: string = view.state.doc.textBetween(contextStart, from, '\n');
      if (contextText.trim().length < 30) return; // too little context

      abortCtrl?.abort();
      abortCtrl = new AbortController();
      options.onLoadingChange?.(true);

      try {
        const suggestion = await options.onSuggest(contextText, abortCtrl.signal);
        if (!abortCtrl.signal.aborted && suggestion.trim()) {
          view.dispatch(
            view.state.tr.setMeta(autocompleteKey, { suggestion: suggestion.trimEnd() })
          );
        }
      } catch (e: any) {
        if (e?.name !== 'AbortError') console.warn('AutoComplete error:', e);
      } finally {
        options.onLoadingChange?.(false);
      }
    };

    const plugin = new Plugin<ACState>({
      key: autocompleteKey,

      state: {
        init: () => ({ suggestion: '' }),
        apply(tr, prev) {
          const meta = tr.getMeta(autocompleteKey);
          if (meta !== undefined) return meta as ACState;
          // Any document edit or cursor move clears the ghost text
          if (tr.docChanged || tr.selectionSet) return { suggestion: '' };
          return prev;
        },
      },

      props: {
        decorations(state) {
          const ps = autocompleteKey.getState(state);
          if (!ps?.suggestion) return DecorationSet.empty;
          if (state.selection.from !== state.selection.to) return DecorationSet.empty;

          const widget = Decoration.widget(
            state.selection.from,
            () => {
              const el = document.createElement('span');
              el.className = 'autocomplete-ghost';
              el.textContent = ps.suggestion;
              el.contentEditable = 'false';
              el.setAttribute('aria-hidden', 'true');
              return el;
            },
            { side: 1, key: 'ac-ghost' }
          );
          return DecorationSet.create(state.doc, [widget]);
        },

        handleKeyDown(view, event) {
          const ps = autocompleteKey.getState(view.state);
          if (!ps?.suggestion) return false;

          if (event.key === 'Tab') {
            event.preventDefault();
            event.stopPropagation();
            view.dispatch(
              view.state.tr
                .insertText(ps.suggestion, view.state.selection.from)
                .setMeta(autocompleteKey, { suggestion: '' })
            );
            return true;
          }

          if (event.key === 'Escape') {
            abortCtrl?.abort();
            view.dispatch(view.state.tr.setMeta(autocompleteKey, { suggestion: '' }));
            return true;
          }

          return false;
        },
      },

      view() {
        return {
          update(view, prevState) {
            if (!options.getEnabled()) return;
            if (!view.state.doc.eq(prevState.doc)) {
              if (debounceTimer) clearTimeout(debounceTimer);
              abortCtrl?.abort();
              options.onLoadingChange?.(false);
              debounceTimer = setTimeout(() => triggerCompletion(view), 1000);
            }
          },
          destroy() {
            if (debounceTimer) clearTimeout(debounceTimer);
            abortCtrl?.abort();
          },
        };
      },
    });

    return [plugin];
  },
});
