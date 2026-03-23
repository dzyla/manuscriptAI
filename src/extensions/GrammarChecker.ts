import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Node as ProsemirrorNode } from '@tiptap/pm/model';

export interface GrammarCheckerOptions {
  rules: { regex: RegExp; message: string }[];
}

const defaultRules = [
  // Repeated words (case insensitive, e.g., "the the")
  { regex: /\\b([a-zA-Z]{2,})\\s+\\1\\b/gi, message: 'Repeated word' },
  // Double spaces
  { regex: /(?<=\\S) {2,}/g, message: 'Multiple spaces' },
  // Space before punctuation
  { regex: /\\s+([.,;:!?])/g, message: 'Space before punctuation' },
  // Repeated punctuation (except ...)
  { regex: /([,;:!])\\1+/g, message: 'Repeated punctuation' },
  { regex: /(\\.)\\1{3,}/g, message: 'Too many dots' },
  // Lowercase after end of sentence
  { regex: /[.!?]\\s+([a-z])/g, message: 'Sentence should start with a capital letter' },
];

function findGrammarErrors(doc: ProsemirrorNode, rules: { regex: RegExp; message: string }[]) {
  const decorations: Decoration[] = [];
  
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;

    for (const rule of rules) {
      const regex = new RegExp(rule.regex);
      let match;
      while ((match = regex.exec(node.text)) !== null) {
        const start = pos + match.index;
        const end = start + match[0].length;
        decorations.push(
          Decoration.inline(start, end, {
            class: 'grammar-error',
            style: 'text-decoration: underline wavy rgba(220, 38, 38, 0.8); text-underline-offset: 3px;',
            title: rule.message,
          })
        );
      }
    }
  });

  return DecorationSet.create(doc, decorations);
}

export const GrammarChecker = Extension.create<GrammarCheckerOptions>({
  name: 'grammarChecker',

  addOptions() {
    return {
      rules: defaultRules,
    };
  },

  addProseMirrorPlugins() {
    const pluginKey = new PluginKey('grammarChecker');
    const rules = this.options.rules;

    return [
      new Plugin({
        key: pluginKey,
        state: {
          init(_, { doc }) {
            return findGrammarErrors(doc, rules);
          },
          apply(tr, oldState) {
            if (!tr.docChanged) {
              return oldState.map(tr.mapping, tr.doc);
            }
            return findGrammarErrors(tr.doc, rules);
          },
        },
        props: {
          decorations(state) {
            return pluginKey.getState(state);
          },
        },
      }),
    ];
  },
});
