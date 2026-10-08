import { Extension } from '@tiptap/core';

/**
 * The Word `w:numId` a list was read from. Several lists can share one numId (a list interrupted by body text and
 * resumed is read as two lists), and the original numbering definition stays in the package's numbering.xml, so the
 * exporter finds the definition by this id. Null for any list the author made in the editor.
 */
export const WordNumbering = Extension.create({
  name: 'wordNumbering',
  addGlobalAttributes() {
    return [
      {
        types: ['bulletList', 'orderedList'],
        attributes: {
          wordNumId: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const raw = el.getAttribute('data-word-num-id');
              const n = raw === null ? NaN : Number(raw);
              return Number.isInteger(n) ? n : null;
            },
            renderHTML: (attrs: Record<string, unknown>) =>
              typeof attrs.wordNumId === 'number' ? { 'data-word-num-id': String(attrs.wordNumId) } : {},
          },
        },
      },
    ];
  },
});
