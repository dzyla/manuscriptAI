import { Extension } from '@tiptap/core';

/**
 * The Word `w:numId` a list was read from. Several lists can share one numId (a list interrupted by body text and
 * resumed is read as two lists), and the original numbering definition stays in the package's numbering.xml. Null for any list the
 * author made in the editor.
 *
 * THIS ID IS A HINT, NOT A GUARANTEE, AND CAN GO STALE. It is the numId the list was READ with. The author can toggle the list
 * between bullets and numbers (the node type changes, this attribute does not), after which `wordNumId` points at a definition of
 * the OTHER kind: emitting it makes Word show numbers for a list the author made a bullet list, or the reverse. A writer must, before
 * trusting it, look up the definition (`w:num` -> `w:abstractNum` -> `w:lvl` for the item's level) and compare its `w:numFmt` with
 * the node type: `bullet` only for a `bulletList`, anything else only for an `orderedList`. On a mismatch (or a null id) it must
 * choose or create a definition of the right kind instead. See docs/superpowers/specs/2026-10-07-a2b-writer-contract.md section 9.
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
